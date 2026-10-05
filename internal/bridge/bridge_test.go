package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func config() Config {
	return Config{Listen: "127.0.0.1:8080", URL: "http://127.0.0.1:1/openai/responses?api-version=test", Key: "mock-key", Auth: "api-key", Deployment: "mock-deployment", BodyLimit: 20 << 20, ResponseLimit: 64 << 20, Timeout: time.Second * 5, IdleTimeout: time.Second}
}
func request(t *testing.T) object {
	t.Helper()
	m, err := decodeObject([]byte(`{"model":"opus","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func fixture(t *testing.T) object {
	t.Helper()
	b, err := os.ReadFile("../../docs/fixtures/messages-responses-tool-cycle.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := decodeObject(b)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func event(t *testing.T, o *Output, e object) error {
	t.Helper()
	b, _ := json.Marshal(e)
	return o.Event("message", string(b))
}
func mustEvent(t *testing.T, o *Output, e object) {
	t.Helper()
	if err := event(t, o, e); err != nil {
		t.Fatal(err)
	}
}
func output(t *testing.T) (*Output, *[]object) {
	t.Helper()
	c := config()
	var events []object
	o := NewOutput(c.Deployment, c.scope(c.Deployment), func(e object) error {
		b, _ := json.Marshal(e)
		v, _ := decodeObject(b)
		events = append(events, v)
		return nil
	}, []any{object{"name": "Read"}, object{"name": "Bash"}})
	if err := o.Start(); err != nil {
		t.Fatal(err)
	}
	return o, &events
}
func terminal(items ...any) object {
	return object{"type": "response.completed", "response": object{"status": "completed", "output": items, "usage": object{"input_tokens": 100, "output_tokens": 20, "input_tokens_details": object{"cached_tokens": 60}}}}
}
func textItem(id, text string) object {
	return object{"id": id, "type": "message", "content": []any{object{"type": "output_text", "text": text}}}
}

func TestFixtureToolReasoningReplay(t *testing.T) {
	f := fixture(t)
	c := config()
	r, err := Translate(obj(f["request"]), c)
	if err != nil {
		t.Fatal(err)
	}
	if str(r.Body, "model") != c.Deployment {
		t.Fatal("wrong deployment")
	}
	o, events := output(t)
	for _, raw := range arr(f["upstreamEvents"]) {
		mustEvent(t, o, obj(raw))
	}
	if !o.terminal {
		t.Fatal("no terminal")
	}
	content := arr(o.JSON()["content"])
	if len(content) != 2 {
		t.Fatalf("content: %v", content)
	}
	thinking, tool := obj(content[0]), obj(content[1])
	if str(tool, "id") != "call_1" {
		t.Fatal("lost call id")
	}
	u := obj(o.JSON()["usage"])
	if u["input_tokens"] != int64(40) || u["cache_read_input_tokens"] != int64(60) || u["output_tokens"] != int64(20) {
		t.Fatalf("usage: %v", u)
	}
	deltas := 0
	for _, e := range *events {
		if str(obj(e["delta"]), "type") == "input_json_delta" {
			deltas++
		}
	}
	if deltas != 2 {
		t.Fatalf("duplicated deltas: %d", deltas)
	}
	m := request(t)
	m["tools"] = f["request"].(object)["tools"]
	m["messages"] = []any{object{"role": "user", "content": "read"}, object{"role": "assistant", "content": content}, object{"role": "user", "content": []any{object{"type": "text", "text": "before"}, object{"type": "tool_result", "tool_use_id": "call_1", "content": "file"}, object{"type": "text", "text": "after"}}}}
	r, err = Translate(m, c)
	if err != nil {
		t.Fatal(err)
	}
	input := arr(r.Body["input"])
	var types []string
	for _, v := range input {
		types = append(types, str(obj(v), "type"))
	}
	if strings.Join(types, ",") != "message,reasoning,function_call,message,function_call_output,message" {
		t.Fatal(types)
	}
	if str(obj(input[4]), "call_id") != "call_1" {
		t.Fatal("output call mismatch")
	}
	if _, err = decodeReasoning(str(thinking, "signature"), c.scope("changed"), c.Deployment); err == nil {
		t.Fatal("cross-scope replay accepted")
	}
	c.Key = "different-key"
	if _, err = Translate(m, c); err == nil {
		t.Fatal("credential change accepted")
	}
}

type chunks struct{ parts [][]byte }

func (r *chunks) Read(p []byte) (int, error) {
	for len(r.parts) > 0 && len(r.parts[0]) == 0 {
		r.parts = r.parts[1:]
	}
	if len(r.parts) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.parts[0])
	r.parts[0] = r.parts[0][n:]
	return n, nil
}
func TestSSEEverySplit(t *testing.T) {
	wire := []byte(": ping\r\nevent: demo\r\ndata: привет 😀\r\ndata: second\r\n\r\n")
	for i := 0; i <= len(wire); i++ {
		n := 0
		err := ReadSSE(&chunks{[][]byte{wire[:i], wire[i:]}}, 1024, func(name, data string) error {
			n++
			if name != "demo" || data != "привет 😀\nsecond" {
				t.Fatalf("split %d: %q %q", i, name, data)
			}
			return nil
		})
		if err != nil || n != 1 {
			t.Fatalf("split %d: %v count=%d", i, err, n)
		}
	}
}
func TestSSELimitAndUnterminatedEvent(t *testing.T) {
	if err := ReadSSE(strings.NewReader("data: abc\n\n"), 2, func(string, string) error { return nil }); err == nil {
		t.Fatal("limit ignored")
	}
	n := 0
	_ = ReadSSE(strings.NewReader("data: unterminated"), 100, func(string, string) error { n++; return nil })
	if n != 0 {
		t.Fatal("unterminated event dispatched")
	}
}

func TestTextFallbackAndMaxTokens(t *testing.T) {
	o, events := output(t)
	mustEvent(t, o, object{"type": "response.output_text.delta", "item_id": "m1", "content_index": 0, "delta": "hé"})
	mustEvent(t, o, object{"type": "response.output_text.done", "item_id": "m1", "content_index": 0, "text": "héllo"})
	e := terminal(textItem("m1", "héllo"))
	e["type"] = "response.incomplete"
	obj(e["response"])["incomplete_details"] = object{"reason": "max_output_tokens"}
	obj(e["response"])["status"] = "incomplete"
	mustEvent(t, o, e)
	if o.JSON()["stop_reason"] != "max_tokens" {
		t.Fatal(o.JSON())
	}
	var text string
	for _, e := range *events {
		d := obj(e["delta"])
		if str(d, "type") == "text_delta" {
			text += str(d, "text")
		}
	}
	if text != "héllo" {
		t.Fatal(text)
	}
}
func TestToolsParallelLateIdentityAndValidation(t *testing.T) {
	o, _ := output(t)
	mustEvent(t, o, object{"type": "response.function_call_arguments.delta", "item_id": "a", "delta": "{\"path\":"})
	mustEvent(t, o, object{"type": "response.output_item.added", "item": object{"id": "b", "type": "function_call", "call_id": "cb", "name": "Bash"}})
	mustEvent(t, o, object{"type": "response.function_call_arguments.delta", "item_id": "b", "delta": "{}"})
	mustEvent(t, o, object{"type": "response.output_item.added", "item": object{"id": "a", "type": "function_call", "call_id": "ca", "name": "Read"}})
	mustEvent(t, o, object{"type": "response.function_call_arguments.delta", "item_id": "a", "delta": "\"x\"}"})
	mustEvent(t, o, terminal(object{"id": "a", "type": "function_call", "call_id": "ca", "name": "Read", "arguments": "{\"path\":\"x\"}"}, object{"id": "b", "type": "function_call", "call_id": "cb", "name": "Bash", "arguments": "{}"}))
	if len(arr(o.JSON()["content"])) != 2 {
		t.Fatal(o.JSON())
	}
	for _, args := range []string{"{broken", "[]", "null", "{\"x\":1} trailing"} {
		t.Run(args, func(t *testing.T) {
			o, events := output(t)
			err := event(t, o, terminal(object{"id": "a", "type": "function_call", "call_id": "c", "name": "Read", "arguments": args}))
			if err == nil {
				t.Fatal("invalid args accepted")
			}
			for _, e := range *events {
				if str(e, "type") == "content_block_stop" {
					t.Fatal("invalid tool closed successfully")
				}
			}
		})
	}
	o, _ = output(t)
	mustEvent(t, o, object{"type": "response.function_call_arguments.delta", "item_id": "a", "delta": "{\"x\":1}"})
	if event(t, o, terminal(object{"id": "a", "type": "function_call", "call_id": "c", "name": "Read", "arguments": "{\"x\":2}"})) == nil {
		t.Fatal("same-length disagreement accepted")
	}
}
func TestUnsupportedAndMalformedRequests(t *testing.T) {
	for _, edit := range []func(object){func(m object) {
		m["messages"] = []any{object{"role": "user", "content": []any{object{"type": "tool_reference"}}}}
	}, func(m object) { m["tools"] = []any{object{"type": "web_search_20250305", "name": "web_search"}} }, func(m object) { m["stop_sequences"] = []any{"stop"} }, func(m object) {
		m["messages"] = []any{object{"role": "user", "content": []any{object{"type": "tool_result", "tool_use_id": "unknown", "content": "x"}}}}
	}, func(m object) {
		m["messages"] = []any{object{"role": "assistant", "content": []any{object{"type": "thinking", "thinking": "state", "signature": "fake"}}}}
	}, func(m object) { m["stream"] = "yes" }} {
		m := request(t)
		edit(m)
		if _, err := Translate(m, config()); err == nil {
			t.Fatal("unsupported request accepted", m)
		}
	}
}
func TestSemanticErrors(t *testing.T) {
	for _, e := range []object{object{"type": "response.failed"}, object{"type": "response.incomplete", "response": object{"incomplete_details": object{"reason": "content_filter"}}}, terminal(object{"id": "search", "type": "web_search_call"}), terminal(object{"id": "r", "type": "reasoning", "summary": []any{}}), object{"type": "response.audio.delta"}} {
		o, _ := output(t)
		if event(t, o, e) == nil {
			t.Fatal("semantic error accepted", e)
		}
	}
}

func mockBridge(t *testing.T, handler http.HandlerFunc) (*pipeHTTP, *atomic.Int32) {
	t.Helper()
	count := &atomic.Int32{}
	up := newPipeHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if r.URL.RequestURI() != "/openai/responses?api-version=test" || r.Header.Get("api-key") != "mock-key" {
			t.Error("URL/auth mismatch")
		}
		handler(w, r)
	}))
	t.Cleanup(up.Close)
	c := config()
	c.URL = up.URL + "/openai/responses?api-version=test"
	s := NewServer(c)
	s.Client = up.Client
	s.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	down := newPipeHTTP(t, s)
	t.Cleanup(down.Close)
	return down, count
}
func post(t *testing.T, server *pipeHTTP, stream bool) *http.Response {
	t.Helper()
	m := request(t)
	m["stream"] = stream
	b, _ := json.Marshal(m)
	r, err := server.Client.Post(server.URL+"/v1/messages?beta=true", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Body.Close() })
	return r
}
func TestHTTPTextBothModes(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[stream], func(t *testing.T) {
			down, count := mockBridge(t, func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				m, err := decodeObject(b)
				if err != nil || m["stream"] != true || str(m, "model") != "mock-deployment" {
					t.Error("bad upstream request")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write(sseBytes(terminal(textItem("m", "ok"))))
			})
			res := post(t, down, stream)
			b, _ := io.ReadAll(res.Body)
			if res.StatusCode != 200 || !bytes.Contains(b, []byte("ok")) {
				t.Fatalf("%d %s", res.StatusCode, b)
			}
			if stream && !bytes.Contains(b, []byte("message_stop")) {
				t.Fatal("missing stop")
			}
			if count.Load() != 1 {
				t.Fatal("repeated request")
			}
		})
	}
}
func TestHTTPStatusAndEarlyEOF(t *testing.T) {
	for _, status := range []int{404, 429, 200} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			down, count := mockBridge(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Retry-After", "3")
				w.WriteHeader(status)
				if status == 200 {
					w.Write(sseBytes(object{"type": "response.output_text.delta", "item_id": "m", "content_index": 0, "delta": "partial"}))
				}
			})
			for _, stream := range []bool{false, true} {
				res := post(t, down, stream)
				b, _ := io.ReadAll(res.Body)
				if status == 200 {
					if stream {
						if res.StatusCode != 200 || !bytes.Contains(b, []byte("event: error")) || bytes.Contains(b, []byte("message_stop")) {
							t.Fatalf("%d %s", res.StatusCode, b)
						}
					} else if res.StatusCode != 502 {
						t.Fatal(res.StatusCode)
					}
				} else if res.StatusCode != status || res.Header.Get("Retry-After") != "3" {
					t.Fatal(res.StatusCode)
				}
			}
			if count.Load() != 2 {
				t.Fatal("unexpected retry", count.Load())
			}
		})
	}
}
func TestHTTPDisconnectCancelsUpstream(t *testing.T) {
	cancelled := make(chan struct{})
	down, _ := mockBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write(sseBytes(object{"type": "response.output_text.delta", "item_id": "m", "content_index": 0, "delta": "first"}))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	})
	ctx, cancel := context.WithCancel(context.Background())
	m := request(t)
	m["stream"] = true
	b, _ := json.Marshal(m)
	req, _ := http.NewRequestWithContext(ctx, "POST", down.URL+"/v1/messages", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := down.Client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_, _ = res.Body.Read(buf)
	cancel()
	res.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not cancelled")
	}
}
func TestIdleTimeout(t *testing.T) {
	cancelled := make(chan struct{})
	up := newPipeHTTP(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer up.Close()
	c := config()
	c.URL = up.URL + "/responses"
	c.IdleTimeout = 30 * time.Millisecond
	s := NewServer(c)
	s.Client = up.Client
	s.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	down := newPipeHTTP(t, s)
	defer down.Close()
	res := post(t, down, false)
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 502 {
		t.Fatalf("%d %s", res.StatusCode, b)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("idle upstream not closed")
	}
}
func TestConfigAndRedaction(t *testing.T) {
	c := config()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.URL = "https://example.com/responses?api-version=v1&key=secret"
	if strings.Contains(c.SafeURL(), "secret") {
		t.Fatal("secret in URL")
	}
	c.Listen = "0.0.0.0:8080"
	if c.Validate() == nil {
		t.Fatal("public unauthenticated listener")
	}
	c.Token = "local"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.URL = "http://example.com/responses"
	if c.Validate() == nil {
		t.Fatal("insecure non-local upstream")
	}
}

// Real HTTP/1.1 over net.Pipe: no TCP listener or sandbox network access required.
type pipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *pipeListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *pipeListener) Addr() net.Addr { return pipeAddr("memory") }

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }

type pipeHTTP struct {
	URL       string
	Client    *http.Client
	server    *http.Server
	listener  *pipeListener
	transport *http.Transport
}

func newPipeHTTP(t *testing.T, h http.Handler) *pipeHTTP {
	t.Helper()
	l := &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		a, b := net.Pipe()
		select {
		case l.conns <- b:
			return a, nil
		case <-ctx.Done():
			a.Close()
			b.Close()
			return nil, ctx.Err()
		case <-l.done:
			a.Close()
			b.Close()
			return nil, net.ErrClosed
		}
	}}
	v := &pipeHTTP{URL: "http://127.0.0.1", Client: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, server: &http.Server{Handler: h}, listener: l, transport: tr}
	go func() { _ = v.server.Serve(l) }()
	t.Cleanup(v.Close)
	return v
}
func (v *pipeHTTP) Close() {
	v.transport.CloseIdleConnections()
	_ = v.server.Close()
	_ = v.listener.Close()
}
