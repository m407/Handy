# External speech recognition

Handy recognizes speech locally by default. To use a remote service, open
**General → Speech recognition provider**, enable the external provider, enter
its API base URL, audio model and API key, then save. The same form is available
in the first-run model picker, so downloading a local speech model is optional.

| Service           | API base URL                     | Example audio model              |
| ----------------- | -------------------------------- | -------------------------------- |
| OpenAI            | `https://api.openai.com/v1`      | `whisper-1`                      |
| Groq              | `https://api.groq.com/openai/v1` | `whisper-large-v3`               |
| Compatible server | Your server's API base URL       | A model supported by that server |

The server must implement the OpenAI multipart `POST /audio/transcriptions` API
and return JSON with a `text` string. Chat-only LLM endpoints do not support this
interface. Keys can be left blank for servers that do not require authentication.

Speech recognition and **Post Processing** have independent URLs, credentials,
and models. For example, use Groq for speech and an Anthropic model for text
improvement. The normal transcription shortcut performs speech recognition;
the post-processing shortcut additionally uses the configured text provider.
Changing either provider does not overwrite the other's settings.

External mode uploads recorded audio to the configured service. Its pricing and
privacy terms apply. Credentials are persisted in Handy's settings, like existing
post-processing credentials, and redacted from Rust debug output. Disabling
external mode restores local recognition and preserves both configurations.

Audio is sent as a 16 kHz mono PCM WAV after recording stops. Live transcription
and local long-form chunking are not used in external mode. The upload limit is
25 MB (approximately 13 minutes); larger recordings fail explicitly rather than
being truncated. Requests time out after 120 seconds. Failures do not silently
send the recording to another provider. Cancelling suppresses text output, but
cannot recall audio already uploaded.

The language selector sends a language hint unless set to Auto. Translate to
English uses `/audio/translations`; enable it only with a service/model supporting
that endpoint. Automatic language detection and supported languages depend on
the selected service/model.

History retries and `--transcribe-file` use the selected speech provider too.
With external mode enabled, local-only CLI overrides `--model` and
`--device-index` are rejected; disable external mode before using these options.
