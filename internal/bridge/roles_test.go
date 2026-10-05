package bridge

import "testing"

func TestInlineInstructionsRetainRoleAndPosition(t *testing.T) {
	m := request(t)
	m["system"] = "top-level instructions"
	m["messages"] = []any{
		object{"role": "user", "content": "before"},
		object{"role": "system", "content": "inline system"},
		object{"role": "assistant", "content": "answer"},
		object{"role": "developer", "content": []any{object{"type": "text", "text": "inline developer"}}},
		object{"role": "user", "content": "after"},
	}
	r, err := Translate(m, config())
	if err != nil {
		t.Fatal(err)
	}
	if str(r.Body, "instructions") != "top-level instructions" {
		t.Fatal("top-level instructions changed")
	}
	input := arr(r.Body["input"])
	if len(input) != 5 {
		t.Fatal("history length changed")
	}
	for i, role := range []string{"user", "system", "assistant", "developer", "user"} {
		item := obj(input[i])
		if str(item, "role") != role {
			t.Fatalf("position %d: %v", i, item)
		}
		part := obj(arr(item["content"])[0])
		typ := "input_text"
		if role == "assistant" {
			typ = "output_text"
		}
		if str(part, "type") != typ {
			t.Fatal("wrong content type", part)
		}
	}
}

func TestInstructionRoleRejectsNonTextAndUnknownRole(t *testing.T) {
	for _, msg := range []object{
		{"role": "system", "content": []any{object{"type": "tool_use", "id": "x", "name": "Read", "input": object{}}}},
		{"role": "developer", "content": []any{object{"type": "image"}}},
		{"role": "tool", "content": "result"},
	} {
		m := request(t)
		m["messages"] = []any{msg}
		if _, err := Translate(m, config()); err == nil {
			t.Fatal("unsupported message accepted", msg)
		}
	}
}
