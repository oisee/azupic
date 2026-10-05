package bridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen, URL, Key, Auth, Deployment, Token, Effort, Scope string
	Aliases                                                  map[string]string
	BodyLimit, ResponseLimit                                 int64
	Timeout, IdleTimeout                                     time.Duration
}

func LoadConfig() (Config, error) {
	deployment := env("AZURE_DEPLOYMENT", os.Getenv("AZURE_OPENAI_DEPLOYMENT"))
	if a, b := os.Getenv("AZURE_DEPLOYMENT"), os.Getenv("AZURE_OPENAI_DEPLOYMENT"); a != "" && b != "" && a != b {
		return Config{}, fmt.Errorf("AZURE_DEPLOYMENT and AZURE_OPENAI_DEPLOYMENT disagree; set only one or use matching values")
	}
	c := Config{Listen: env("LISTEN_ADDR", "127.0.0.1:8080"), URL: os.Getenv("AZURE_RESPONSES_URL"), Key: os.Getenv("AZURE_OPENAI_API_KEY"), Auth: env("AZURE_AUTH_MODE", "api-key"), Deployment: deployment, Token: os.Getenv("AZUPIC_TOKEN"), Effort: os.Getenv("REASONING_EFFORT"), BodyLimit: 20 << 20, ResponseLimit: 64 << 20, Timeout: 10 * time.Minute, IdleTimeout: 5 * time.Minute}
	if s := os.Getenv("AZUPIC_MODEL_ALIASES"); s != "" {
		if err := json.Unmarshal([]byte(s), &c.Aliases); err != nil {
			return c, fmt.Errorf("AZUPIC_MODEL_ALIASES must be a JSON string map")
		}
	}
	for name, dst := range map[string]*int64{"AZUPIC_BODY_LIMIT": &c.BodyLimit, "AZUPIC_RESPONSE_LIMIT": &c.ResponseLimit} {
		if s := os.Getenv(name); s != "" {
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil || n <= 0 {
				return c, fmt.Errorf("%s must be positive bytes", name)
			}
			*dst = n
		}
	}
	for name, dst := range map[string]*time.Duration{"AZUPIC_TIMEOUT": &c.Timeout, "AZUPIC_IDLE_TIMEOUT": &c.IdleTimeout} {
		if s := os.Getenv(name); s != "" {
			d, err := time.ParseDuration(s)
			if err != nil || d <= 0 {
				return c, fmt.Errorf("%s must be a positive duration", name)
			}
			*dst = d
		}
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("AZURE_RESPONSES_URL must be a full HTTP(S) URL without userinfo or fragment")
	}
	if !strings.HasSuffix(u.Path, "/responses") {
		return fmt.Errorf("AZURE_RESPONSES_URL path must end in /responses")
	}
	if u.Scheme == "http" && !loopback(u.Hostname()) {
		return fmt.Errorf("HTTP upstream is allowed only on loopback for local mocks")
	}
	if c.Key == "" || c.Deployment == "" {
		return fmt.Errorf("AZURE_OPENAI_API_KEY and AZURE_DEPLOYMENT (or AZURE_OPENAI_DEPLOYMENT) are required")
	}
	if strings.ContainsAny(c.Key, "\r\n") || strings.ContainsAny(c.Token, "\r\n") {
		return fmt.Errorf("credentials must not contain newlines")
	}
	if c.Auth != "api-key" && c.Auth != "bearer" {
		return fmt.Errorf("AZURE_AUTH_MODE must be api-key or bearer")
	}
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("LISTEN_ADDR must be host:port")
	}
	if !loopback(host) && c.Token == "" {
		return fmt.Errorf("AZUPIC_TOKEN is required when listening outside loopback")
	}
	if c.Effort != "" && !validEffort(c.Effort) {
		return fmt.Errorf("unsupported REASONING_EFFORT")
	}
	if c.BodyLimit <= 0 || c.ResponseLimit <= 0 || c.Timeout <= 0 || c.IdleTimeout <= 0 {
		return fmt.Errorf("limits and timeouts must be positive")
	}
	for alias, model := range c.Aliases {
		if alias == "" || model == "" {
			return fmt.Errorf("model aliases must be nonempty")
		}
	}
	return nil
}

func (c Config) model(alias string) string {
	if m := c.Aliases[alias]; m != "" {
		return m
	}
	return c.Deployment
}
func (c Config) scope(model string) string {
	// Credential changes invalidate replay without putting the credential in the envelope.
	h := sha256.Sum256([]byte(c.URL + "\x00" + c.Auth + "\x00" + c.Key + "\x00" + c.Scope + "\x00" + model))
	return hex.EncodeToString(h[:])
}
func (c Config) SafeURL() string {
	u, err := url.Parse(c.URL)
	if err != nil {
		return "<invalid URL>"
	}
	q := u.Query()
	for k := range q {
		if k != "api-version" {
			q.Set(k, "REDACTED")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
func loopback(host string) bool { ip := net.ParseIP(host); return ip != nil && ip.IsLoopback() }
func validEffort(s string) bool {
	switch s {
	case "none", "minimal", "low", "medium", "high", "xhigh":
		return true
	}
	return false
}
func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
