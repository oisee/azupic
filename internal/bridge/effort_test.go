package bridge

import "testing"

func TestEffortChangesPerRequest(t *testing.T) {
	c := config()
	c.Effort = "medium"
	for _, test := range []struct{ client, want string }{{"low", "low"}, {"high", "high"}, {"xhigh", "xhigh"}, {"max", "xhigh"}, {"", "medium"}} {
		m := request(t)
		if test.client != "" {
			m["output_config"] = object{"effort": test.client}
		}
		r, err := Translate(m, c)
		if err != nil {
			t.Fatal(err)
		}
		if got := str(obj(r.Body["reasoning"]), "effort"); got != test.want {
			t.Fatalf("client=%q got=%q want=%q", test.client, got, test.want)
		}
	}
	if c.Effort != "medium" {
		t.Fatal("client mutated shared fallback")
	}
	m := request(t)
	m["thinking"] = object{"type": "adaptive", "effort": "low"}
	m["output_config"] = object{"effort": "high"}
	r, err := Translate(m, c)
	if err != nil {
		t.Fatal(err)
	}
	if str(obj(r.Body["reasoning"]), "effort") != "high" {
		t.Fatal("wrong effort priority")
	}
	c.Effort = ""
	r, err = Translate(request(t), c)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := obj(r.Body["reasoning"])["effort"]; ok {
		t.Fatal("provider default overridden")
	}
}
