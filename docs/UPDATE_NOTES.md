# Update Notes

## 2026-03-04

### Chat Provider Compatibility Update

`/api/v1/chat/reply` now supports natural provider aliases so agent prompts can use common names:

- `claude` maps to `anthropic`
- `google` maps to `gemini`

### Environment Alias Support

Additional environment variable aliases are now accepted:

- Claude:
  - `CLAUDE_API_KEY` (alias of `ANTHROPIC_API_KEY`)
  - `CLAUDE_CHAT_MODEL` (alias of `ANTHROPIC_CHAT_MODEL`)
- Google Gemini:
  - `GOOGLE_API_KEY`
  - `GOOGLE_GENAI_API_KEY`
  - `GOOGLE_CHAT_MODEL` (alias of `GEMINI_CHAT_MODEL`)

### Validation

Validated after patch:

- `npm test`
- `npm run lint`
- `npm run security:check`

### Commit Reference

- `a4ee9c6` — Add Claude/Google provider aliases for model-backed chat
