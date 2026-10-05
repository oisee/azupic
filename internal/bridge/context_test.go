package bridge

import (
	"encoding/json"
	"testing"
)

func TestContextClearingRetainsReasoningAndTools(t *testing.T) {
	c := config()
	item := object{"id": "rs", "type": "reasoning", "encrypted_content": "opaque", "summary": []any{}}
	sig, err := encodeReasoning(item, c.scope(c.Deployment), c.Deployment)
	if err != nil {
		t.Fatal(err)
	}
	m := request(t)
	m["messages"] = []any{
		object{"role": "assistant", "content": []any{
			object{"type": "thinking", "thinking": "", "signature": sig},
			object{"type": "tool_use", "id": "call", "name": "Read", "input": object{"path": "file"}},
		}},
		object{"role": "user", "content": []any{object{"type": "tool_result", "tool_use_id": "call", "content": "keep this result"}}},
	}
	base, err := Translate(m, c)
	if err != nil {
		t.Fatal(err)
	}
	m["context_management"] = object{"edits": []any{
		object{"type": "clear_thinking_20251015", "keep": "all"},
		object{"type": "clear_tool_uses_20250919", "trigger": object{"type": "input_tokens", "value": 1}},
	}}
	with, err := Translate(m, c)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(base.Body)
	b, _ := json.Marshal(with.Body)
	if string(a) != string(b) {
		t.Fatal("clearing changed upstream history")
	}
}

func TestContextManagementRejectsUnknownStrategies(t *testing.T) {
	for _, v := range []any{"invalid", object{}, object{"edits": "invalid"}, object{"edits": []any{object{"type": "compact_20260112"}}}, object{"edits": []any{object{"type": "unknown"}}}, object{"edits": []any{}, "unknown": true}} {
		m := request(t)
		m["context_management"] = v
		if _, err := Translate(m, config()); err == nil {
			t.Fatalf("accepted unsupported context management: %v", v)
		}
	}
}
