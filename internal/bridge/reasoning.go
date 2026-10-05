package bridge

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

const signaturePrefix = "azupic:responses:v1:"
const signatureLimit = 4 << 20

type envelope struct {
	Version int    `json:"version"`
	Scope   string `json:"scope"`
	Model   string `json:"model"`
	Item    object `json:"item"`
}

func encodeReasoning(item object, scope, model string) (string, error) {
	if str(item, "type") != "reasoning" || str(item, "encrypted_content") == "" {
		return "", fmt.Errorf("reasoning item has no encrypted state")
	}
	b, err := json.Marshal(envelope{1, scope, model, item})
	if err != nil {
		return "", err
	}
	if base64.RawURLEncoding.EncodedLen(len(b))+len(signaturePrefix) > signatureLimit {
		return "", fmt.Errorf("reasoning signature exceeds limit")
	}
	return signaturePrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

func decodeReasoning(sig, scope, model string) (object, error) {
	if !strings.HasPrefix(sig, signaturePrefix) || len(sig) > signatureLimit {
		return nil, fmt.Errorf("unsupported or oversized reasoning signature; start a new session")
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sig, signaturePrefix))
	if err != nil {
		return nil, fmt.Errorf("malformed reasoning signature")
	}
	var e envelope
	if json.Unmarshal(b, &e) != nil || e.Version != 1 || e.Scope != scope || e.Model != model || str(e.Item, "type") != "reasoning" || str(e.Item, "encrypted_content") == "" {
		return nil, fmt.Errorf("invalid reasoning signature or changed endpoint/deployment/credential; start a new session")
	}
	return e.Item, nil
}
