package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type object = map[string]any

func str(m object, k string) string { s, _ := m[k].(string); return s }
func obj(v any) object              { m, _ := v.(map[string]any); return m }
func arr(v any) []any               { a, _ := v.([]any); return a }
func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

func decodeObject(b []byte) (object, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var m object
	if err := d.Decode(&m); err != nil || m == nil {
		return nil, fmt.Errorf("expected a JSON object")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("unexpected trailing JSON")
	}
	return m, nil
}

func blocks(v any) ([]any, error) {
	if s, ok := v.(string); ok {
		return []any{object{"type": "text", "text": s}}, nil
	}
	if a, ok := v.([]any); ok {
		return a, nil
	}
	return nil, fmt.Errorf("content must be a string or array")
}

type Request struct {
	Body   object
	Model  string
	Stream bool
}

func Translate(m object, c Config) (Request, error) {
	fail := func(s string) (Request, error) { return Request{}, fmt.Errorf("%s", s) }
	if str(m, "model") == "" {
		return fail("model is required")
	}
	stream := false
	if v, ok := m["stream"]; ok {
		var valid bool
		stream, valid = v.(bool)
		if !valid {
			return fail("stream must be boolean")
		}
	}
	max, ok := number(m["max_tokens"])
	if !ok || max <= 0 {
		return fail("max_tokens must be a positive integer")
	}
	if err := validateContextManagement(m["context_management"]); err != nil {
		return Request{}, err
	}
	for _, k := range []string{"stop_sequences", "top_p", "top_k"} {
		if v, ok := m[k]; ok && v != nil {
			if k == "stop_sequences" && len(arr(v)) == 0 {
				continue
			}
			return fail(k + " is unsupported")
		}
	}
	if v, ok := m["temperature"]; ok {
		n, valid := number(v)
		if !valid || n != 1 {
			return fail("only default temperature=1 is accepted; Azure reasoning controls sampling")
		}
	}
	model := c.model(str(m, "model"))
	scope := c.scope(model)
	body := object{"model": model, "stream": true, "store": false, "max_output_tokens": max, "include": []string{"reasoning.encrypted_content"}}
	effort := c.Effort
	if thinking := obj(m["thinking"]); thinking != nil {
		switch str(thinking, "type") {
		case "enabled", "adaptive", "disabled":
		default:
			return fail("unsupported thinking.type")
		}
		if v := str(thinking, "effort"); v != "" {
			effort = v
		}
		// budget_tokens is an Anthropic budget, not an Azure output limit.
	}
	if output := obj(m["output_config"]); output != nil {
		if v := str(output, "effort"); v != "" {
			effort = v
		}
		if f := obj(output["format"]); f != nil {
			if str(f, "type") != "json_schema" || obj(f["schema"]) == nil {
				return fail("output_config.format requires json_schema with an object schema")
			}
			body["text"] = object{"format": object{"type": "json_schema", "name": "azupic_output", "schema": f["schema"], "strict": true}}
		}
	}
	if effort != "" {
		// Anthropic max has no Responses spelling; use our explicit ceiling.
		if effort == "max" {
			effort = "xhigh"
		}
		if !validEffort(effort) {
			return fail("unsupported reasoning effort")
		}
		body["reasoning"] = object{"effort": effort, "summary": "auto"}
	} else {
		body["reasoning"] = object{"summary": "auto"}
	}
	if sys, exists := m["system"]; exists {
		bs, err := blocks(sys)
		if err != nil {
			return Request{}, err
		}
		var texts []string
		for _, b := range bs {
			v := obj(b)
			if str(v, "type") != "text" {
				return fail("only text system blocks are supported")
			}
			s, ok := v["text"].(string)
			if !ok {
				return fail("system text must be a string")
			}
			texts = append(texts, s)
		}
		body["instructions"] = strings.Join(texts, "\n\n")
	}
	tools := []any{}
	names := map[string]bool{}
	if v, exists := m["tools"]; exists {
		if _, ok := v.([]any); !ok {
			return fail("tools must be an array")
		}
		for _, v := range arr(v) {
			t := obj(v)
			name := str(t, "name")
			if typ := str(t, "type"); typ != "" && typ != "custom" {
				return fail("native tool " + typ + " is unsupported; use Claude Code local tools")
			}
			if name == "" || names[name] || len(name) > 64 || !toolName(name) {
				return fail("invalid or duplicate tool name")
			}
			names[name] = true
			if obj(t["input_schema"]) == nil {
				return fail("tool input_schema must be an object")
			}
			if b, _ := t["defer_loading"].(bool); b {
				return fail("deferred tools are unsupported; disable Claude Code tool search")
			}
			tools = append(tools, object{"type": "function", "name": name, "description": str(t, "description"), "parameters": t["input_schema"], "strict": false})
		}
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	if choice := obj(m["tool_choice"]); choice != nil {
		switch str(choice, "type") {
		case "auto", "none":
			body["tool_choice"] = str(choice, "type")
		case "any":
			body["tool_choice"] = "required"
		case "tool":
			if !names[str(choice, "name")] {
				return fail("tool_choice names an undefined tool")
			}
			body["tool_choice"] = object{"type": "function", "name": str(choice, "name")}
		default:
			return fail("unsupported tool_choice")
		}
		if v, ok := choice["disable_parallel_tool_use"]; ok {
			b, ok := v.(bool)
			if !ok {
				return fail("disable_parallel_tool_use must be boolean")
			}
			body["parallel_tool_calls"] = !b
		}
	}
	messages, ok := m["messages"].([]any)
	if !ok || len(messages) == 0 {
		return fail("messages must be a nonempty array")
	}
	input := []any{}
	pending := map[string]bool{}
	seen := map[string]bool{}
	for _, raw := range messages {
		msg := obj(raw)
		role := str(msg, "role")
		if role != "user" && role != "assistant" && role != "system" && role != "developer" {
			return fail("unsupported messages role: " + role)
		}
		bs, err := blocks(msg["content"])
		if err != nil {
			return Request{}, err
		}
		content := []any{}
		flush := func() {
			if len(content) > 0 {
				input = append(input, object{"type": "message", "role": role, "content": content})
				content = []any{}
			}
		}
		for _, raw := range bs {
			b := obj(raw)
			if (role == "system" || role == "developer") && str(b, "type") != "text" {
				return fail("system/developer messages support only text blocks")
			}
			switch str(b, "type") {
			case "text":
				s, ok := b["text"].(string)
				if !ok {
					return fail("text must be a string")
				}
				typ := "input_text"
				if role == "assistant" {
					typ = "output_text"
				}
				content = append(content, object{"type": typ, "text": s})
			case "image":
				if role != "user" {
					return fail("assistant images are unsupported")
				}
				im, err := image(b)
				if err != nil {
					return Request{}, err
				}
				content = append(content, im)
			case "tool_use":
				if role != "assistant" {
					return fail("tool_use requires assistant role")
				}
				id, name := str(b, "id"), str(b, "name")
				if id == "" || name == "" || seen[id] || obj(b["input"]) == nil {
					return fail("tool_use requires unique id, name and object input")
				}
				flush()
				args, _ := json.Marshal(b["input"])
				input = append(input, object{"type": "function_call", "call_id": id, "name": name, "arguments": string(args)})
				pending[id] = true
				seen[id] = true
			case "tool_result":
				id := str(b, "tool_use_id")
				if role != "user" || !pending[id] {
					return fail("tool_result must match a preceding unresolved tool_use")
				}
				flush()
				output, err := toolOutput(b)
				if err != nil {
					return Request{}, err
				}
				input = append(input, object{"type": "function_call_output", "call_id": id, "output": output})
				delete(pending, id)
			case "thinking", "redacted_thinking":
				if role != "assistant" {
					return fail("thinking requires assistant role")
				}
				flush()
				item, err := decodeReasoning(str(b, "signature"), scope, model)
				if err != nil {
					return Request{}, err
				}
				input = append(input, item)
			default:
				return fail("unsupported content block: " + str(b, "type"))
			}
		}
		flush()
	}
	if len(pending) > 0 {
		return fail("history contains unresolved tool_use; send all tool results before generating")
	}
	body["input"] = input
	return Request{body, model, stream}, nil
}

// Clearing is an optional server optimization. Retaining the complete history
// preserves tool results and encrypted reasoning for Responses replay. Never
// claim edits were applied; client-side compaction remains the client's job.
func validateContextManagement(v any) error {
	if v == nil {
		return nil
	}
	m := obj(v)
	if m == nil {
		return fmt.Errorf("context_management must be an object")
	}
	for k := range m {
		if k != "edits" {
			return fmt.Errorf("unsupported context_management field: %s", k)
		}
	}
	edits, ok := m["edits"].([]any)
	if !ok {
		return fmt.Errorf("context_management.edits must be an array")
	}
	for _, raw := range edits {
		switch str(obj(raw), "type") {
		case "clear_thinking_20251015", "clear_tool_uses_20250919":
		default:
			return fmt.Errorf("unsupported context_management edit: %s", str(obj(raw), "type"))
		}
	}
	return nil
}

func toolName(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func image(b object) (object, error) {
	s := obj(b["source"])
	var u string
	switch str(s, "type") {
	case "url":
		u = str(s, "url")
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			return nil, fmt.Errorf("image URL must be HTTP(S)")
		}
	case "base64":
		mt := str(s, "media_type")
		switch mt {
		case "image/jpeg", "image/png", "image/gif", "image/webp":
		default:
			return nil, fmt.Errorf("unsupported image media type")
		}
		if str(s, "data") == "" {
			return nil, fmt.Errorf("empty image data")
		}
		u = "data:" + mt + ";base64," + str(s, "data")
	default:
		return nil, fmt.Errorf("unsupported image source")
	}
	return object{"type": "input_image", "image_url": u}, nil
}
func toolOutput(b object) (any, error) {
	v, ok := b["content"]
	if !ok {
		v = ""
	}
	bs, err := blocks(v)
	if err != nil {
		return nil, err
	}
	var text []string
	var parts []any
	hasImage := false
	for _, raw := range bs {
		p := obj(raw)
		switch str(p, "type") {
		case "text":
			s, ok := p["text"].(string)
			if !ok {
				return nil, fmt.Errorf("tool result text must be a string")
			}
			text = append(text, s)
			parts = append(parts, object{"type": "input_text", "text": s})
		case "image":
			im, err := image(p)
			if err != nil {
				return nil, err
			}
			parts = append(parts, im)
			hasImage = true
		default:
			return nil, fmt.Errorf("unsupported tool result block: %s", str(p, "type"))
		}
	}
	if b["is_error"] == true {
		parts = append([]any{object{"type": "input_text", "text": "[tool error]"}}, parts...)
		text = append([]string{"[tool error]"}, text...)
	}
	if hasImage {
		return parts, nil
	}
	return strings.Join(text, "\n"), nil
}
