package bridge

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

type emitFunc func(object) error
type block struct {
	index                             int
	kind, itemID, callID, name, value string
	opened, closed                    bool
	content                           object
}
type Output struct {
	model, scope, id string
	emit             emitFunc
	blocks           []*block
	byKey            map[string]*block
	tools            map[string]*block
	usage            object
	terminal         bool
	toolCalls        bool
	allowed          map[string]bool
	stopReason       string
}

func NewOutput(model, scope string, emit emitFunc, tools []any) *Output {
	allowed := map[string]bool{}
	for _, t := range tools {
		allowed[str(obj(t), "name")] = true
	}
	return &Output{model: model, scope: scope, id: newID("msg_"), emit: emit, byKey: map[string]*block{}, tools: map[string]*block{}, usage: object{"input_tokens": int64(0), "output_tokens": int64(0), "cache_read_input_tokens": int64(0), "cache_creation_input_tokens": int64(0)}, allowed: allowed}
}
func newID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}
func (o *Output) Start() error {
	return o.emit(object{"type": "message_start", "message": object{"id": o.id, "type": "message", "role": "assistant", "model": o.model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": o.usage}})
}
func (o *Output) get(key, kind string) *block {
	if b := o.byKey[key]; b != nil {
		return b
	}
	b := &block{kind: kind, index: -1}
	o.byKey[key] = b
	return b
}
func (o *Output) open(b *block) error {
	if b.opened {
		return nil
	}
	b.opened = true
	b.index = len(o.blocks)
	o.blocks = append(o.blocks, b)
	switch b.kind {
	case "text":
		b.content = object{"type": "text", "text": ""}
	case "thinking":
		b.content = object{"type": "thinking", "thinking": "", "signature": ""}
	case "tool":
		if b.callID == "" || b.name == "" || !o.allowed[b.name] {
			return fmt.Errorf("upstream tool requires call_id and a defined name")
		}
		for _, other := range o.blocks {
			if other != b && other.kind == "tool" && other.callID == b.callID {
				return fmt.Errorf("duplicate upstream call_id")
			}
		}
		b.content = object{"type": "tool_use", "id": b.callID, "name": b.name, "input": object{}}
	}
	return o.emit(object{"type": "content_block_start", "index": b.index, "content_block": b.content})
}
func (o *Output) delta(b *block, s string) error {
	if b.closed {
		return fmt.Errorf("delta after block completion")
	}
	if s == "" {
		return nil
	}
	b.value += s
	if b.kind == "tool" && (b.name == "" || b.callID == "") {
		return nil
	}
	if err := o.open(b); err != nil {
		return err
	}
	return o.sendDelta(b, s)
}
func (o *Output) sendDelta(b *block, s string) error {
	typ, key := "text_delta", "text"
	switch b.kind {
	case "thinking":
		typ, key = "thinking_delta", "thinking"
	case "tool":
		typ, key = "input_json_delta", "partial_json"
	}
	return o.emit(object{"type": "content_block_delta", "index": b.index, "delta": object{"type": typ, key: s}})
}
func (o *Output) full(b *block, s string) error {
	if b.closed {
		if b.value != s {
			return fmt.Errorf("final content differs from completed block")
		}
		return nil
	}
	if !strings.HasPrefix(s, b.value) {
		return fmt.Errorf("final content disagrees with streamed prefix")
	}
	return o.delta(b, strings.TrimPrefix(s, b.value))
}
func (o *Output) close(b *block, sig string) error {
	if b.closed {
		return nil
	}
	if !b.opened {
		if err := o.open(b); err != nil {
			return err
		}
		if b.value != "" {
			if err := o.sendDelta(b, b.value); err != nil {
				return err
			}
		}
	}
	switch b.kind {
	case "tool":
		m, err := decodeObject([]byte(b.value))
		if err != nil {
			return fmt.Errorf("invalid final arguments for tool %s", b.name)
		}
		b.content["input"] = m
		o.toolCalls = true
	case "text":
		b.content["text"] = b.value
	case "thinking":
		if sig == "" {
			return fmt.Errorf("reasoning has no replayable encrypted state")
		}
		b.content["thinking"] = b.value
		b.content["signature"] = sig
		if err := o.emit(object{"type": "content_block_delta", "index": b.index, "delta": object{"type": "signature_delta", "signature": sig}}); err != nil {
			return err
		}
	}
	b.closed = true
	return o.emit(object{"type": "content_block_stop", "index": b.index})
}
func textKey(id string, index any) string { return fmt.Sprintf("text:%s:%v", id, index) }
func (o *Output) tool(item object, id string) (*block, error) {
	if id == "" {
		return nil, fmt.Errorf("function call is missing item id")
	}
	b := o.get("tool:"+id, "tool")
	b.itemID = id
	o.tools[id] = b
	for _, pair := range []struct {
		key string
		dst *string
	}{{"call_id", &b.callID}, {"name", &b.name}} {
		if s := str(item, pair.key); s != "" {
			if *pair.dst != "" && *pair.dst != s {
				return nil, fmt.Errorf("upstream tool identity changed")
			}
			*pair.dst = s
		}
	}
	if !b.opened && b.name != "" && b.callID != "" {
		if err := o.open(b); err != nil {
			return nil, err
		}
		if b.value != "" {
			if err := o.sendDelta(b, b.value); err != nil {
				return nil, err
			}
		}
	}
	return b, nil
}
func (o *Output) item(item object) error {
	id := str(item, "id")
	if id == "" {
		return fmt.Errorf("output item is missing id")
	}
	switch str(item, "type") {
	case "message":
		for i, raw := range arr(item["content"]) {
			p := obj(raw)
			var text string
			switch str(p, "type") {
			case "output_text":
				text = str(p, "text")
			case "refusal":
				text = str(p, "refusal")
			default:
				return fmt.Errorf("unsupported message output: %s", str(p, "type"))
			}
			b := o.get(textKey(id, i), "text")
			if err := o.full(b, text); err != nil {
				return err
			}
			if err := o.close(b, ""); err != nil {
				return err
			}
		}
	case "function_call":
		b, err := o.tool(item, id)
		if err != nil {
			return err
		}
		if err := o.full(b, str(item, "arguments")); err != nil {
			return err
		}
		return o.close(b, "")
	case "reasoning":
		b := o.get("thinking:"+id, "thinking")
		var summary []string
		for _, raw := range arr(item["summary"]) {
			p := obj(raw)
			if str(p, "type") != "summary_text" {
				return fmt.Errorf("unsupported reasoning summary")
			}
			summary = append(summary, str(p, "text"))
		}
		s := strings.Join(summary, "")
		if err := o.full(b, s); err != nil {
			return err
		}
		sig, err := encodeReasoning(item, o.scope, o.model)
		if err != nil {
			return err
		}
		return o.close(b, sig)
	default:
		return fmt.Errorf("unsupported semantic output item: %s", str(item, "type"))
	}
	return nil
}
func (o *Output) Event(name, data string) error {
	if o.terminal {
		return fmt.Errorf("event after terminal response")
	}
	if data == "[DONE]" {
		return fmt.Errorf("upstream ended without a terminal response")
	}
	p, err := decodeObject([]byte(data))
	if err != nil {
		return fmt.Errorf("invalid upstream SSE JSON")
	}
	typ := str(p, "type")
	if typ == "" {
		typ = name
	}
	id := str(p, "item_id")
	switch typ {
	case "response.output_text.delta", "response.refusal.delta":
		if id == "" {
			return fmt.Errorf("text delta is missing item_id")
		}
		idx := p["content_index"]
		if idx == nil {
			idx = 0
		}
		return o.delta(o.get(textKey(id, idx), "text"), str(p, "delta"))
	case "response.output_text.done", "response.refusal.done":
		if id == "" {
			return fmt.Errorf("text completion is missing item_id")
		}
		idx := p["content_index"]
		if idx == nil {
			idx = 0
		}
		b := o.get(textKey(id, idx), "text")
		text := str(p, "text")
		if typ == "response.refusal.done" {
			text = str(p, "refusal")
		}
		if err := o.full(b, text); err != nil {
			return err
		}
		return o.close(b, "")
	case "response.reasoning_summary_text.delta":
		if id == "" {
			return fmt.Errorf("reasoning delta is missing item_id")
		}
		return o.delta(o.get("thinking:"+id, "thinking"), str(p, "delta"))
	case "response.reasoning_summary_text.done": // Complete encrypted item is authoritative and closes this block.
		return nil
	case "response.output_item.added":
		item := obj(p["item"])
		if str(item, "type") == "function_call" {
			_, err := o.tool(item, str(item, "id"))
			return err
		}
		if t := str(item, "type"); t != "message" && t != "reasoning" {
			return fmt.Errorf("unsupported output item: %s", t)
		}
	case "response.function_call_arguments.delta":
		if id == "" {
			return fmt.Errorf("tool arguments are missing item_id")
		}
		b := o.get("tool:"+id, "tool")
		b.itemID = id
		o.tools[id] = b
		return o.delta(b, str(p, "delta"))
	case "response.function_call_arguments.done":
		if id == "" {
			return fmt.Errorf("tool arguments are missing item_id")
		}
		b := o.get("tool:"+id, "tool")
		return o.full(b, str(p, "arguments")) // Validate and close when identity is final.
	case "response.output_item.done":
		return o.item(obj(p["item"]))
	case "response.completed", "response.incomplete":
		r := obj(p["response"])
		if r == nil {
			return fmt.Errorf("terminal event is missing response")
		}
		if _, ok := r["output"].([]any); !ok {
			return fmt.Errorf("terminal response output must be an array")
		}
		status := str(r, "status")
		if typ == "response.completed" && status != "completed" {
			return fmt.Errorf("unexpected completed status")
		}
		if typ == "response.incomplete" && str(obj(r["incomplete_details"]), "reason") != "max_output_tokens" {
			return fmt.Errorf("upstream response incomplete")
		}
		for _, item := range arr(r["output"]) {
			if err := o.item(obj(item)); err != nil {
				return err
			}
		}
		for _, b := range o.byKey {
			if !b.closed {
				return fmt.Errorf("upstream terminal response left an unfinished block")
			}
		}
		if u := obj(r["usage"]); u != nil {
			in, validIn := number(u["input_tokens"])
			out, validOut := number(u["output_tokens"])
			cached, _ := number(obj(u["input_tokens_details"])["cached_tokens"])
			if !validIn || !validOut || in < 0 || out < 0 || cached < 0 || cached > in {
				return fmt.Errorf("invalid upstream usage")
			}
			o.usage = object{"input_tokens": in - cached, "output_tokens": out, "cache_read_input_tokens": cached, "cache_creation_input_tokens": int64(0)}
		} else {
			return fmt.Errorf("terminal response is missing usage")
		}
		reason := "end_turn"
		if o.toolCalls {
			reason = "tool_use"
		}
		if typ == "response.incomplete" {
			reason = "max_tokens"
		}
		o.stopReason = reason
		if err := o.emit(object{"type": "message_delta", "delta": object{"stop_reason": reason, "stop_sequence": nil}, "usage": o.usage}); err != nil {
			return err
		}
		if err := o.emit(object{"type": "message_stop"}); err != nil {
			return err
		}
		o.terminal = true
	case "response.failed", "error":
		return fmt.Errorf("upstream generation failed")
	case "response.created", "response.in_progress", "response.queued", "response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done":
		return nil
	default:
		if strings.Contains(typ, ".delta") || strings.Contains(typ, ".done") || strings.Contains(typ, ".added") {
			return fmt.Errorf("unsupported semantic event: %s", typ)
		}
	}
	return nil
}

func (o *Output) JSON() object {
	content := []any{}
	for _, b := range o.blocks {
		content = append(content, b.content)
	}
	reason := o.stopReason
	return object{"id": o.id, "type": "message", "role": "assistant", "model": o.model, "content": content, "stop_reason": reason, "stop_sequence": nil, "usage": o.usage}
}

func sseBytes(e object) []byte {
	b, _ := json.Marshal(e)
	return []byte("event: " + str(e, "type") + "\ndata: " + string(b) + "\n\n")
}
