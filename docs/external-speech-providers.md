# Offline, cloud and in-house processing

Handy supports offline speech recognition and optional online processing. Use a
cloud provider if you are comfortable sending your recordings or text to an
external service, or connect a custom provider hosted inside your organization.
The speech and text providers can be different services with different models,
credentials and locations.

## Choose where data is processed

| Configuration                                | Audio processing                                  | Text improvement                                                              |
| -------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Local recognition, no remote Post Processing | On your computer                                  | Disabled or on-device                                                         |
| Cloud speech provider                        | Audio is uploaded to the configured cloud service | Optional; uses the separately selected text provider                          |
| In-house speech provider                     | Audio is uploaded to your organization's server   | Optional; configure an internal text endpoint to keep this stage in-house too |

Local speech recognition works offline once its model is available. Cloud and
in-house services require a network connection to their configured endpoints.
Selecting local recognition alone does not prevent a remote Post Processing
provider from receiving the transcript when that feature is used.

## Configure speech recognition

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

## Use a custom in-house provider

Set the base URL to the API gateway or model server supplied by your organization,
for example `https://speech.example.internal/v1`, and enter the audio model ID
and credentials supplied by its administrator. The address is illustrative;
use an endpoint reachable from the computer running Handy, through your corporate
network or VPN as needed. It must implement the audio API described above;
an internal chat-only LLM endpoint is not sufficient for speech recognition.

If text improvement is needed, configure a custom/internal provider in
**Post Processing** separately. Using an in-house speech endpoint does not change
an existing cloud text provider. Audio and transcript processing can remain
inside your organization when both chosen services run internally and do not
forward requests to third parties. Data retention and access are determined by
those services and your organization's configuration.

## Independent text improvement

Speech recognition and **Post Processing** have independent URLs, credentials,
and models. For example, use Groq for speech and an Anthropic model for text
improvement. The normal transcription shortcut performs speech recognition;
the post-processing shortcut additionally uses the configured text provider.
Changing either provider does not overwrite the other's settings.

## Data handling and limits

External mode uploads recorded audio to the configured service. Its pricing and
privacy terms apply for cloud services; internal services follow your
organization's policies. Post Processing sends the transcript to its selected
text provider when invoked. Credentials are persisted in Handy's settings, like existing
post-processing credentials, and redacted from Rust debug output. Disabling
external mode restores local recognition and preserves both configurations.

Audio is sent as a 16 kHz mono PCM WAV after recording stops. Live transcription
and local long-form chunking are not used in external mode. The upload limit is
25 MB (approximately 13 minutes); larger recordings fail explicitly rather than
being truncated. Requests time out after 120 seconds. Failures do not silently
send the recording to another provider. Cancelling stops waiting for the external request and releases the recording
pipeline for the next recording. It cannot recall audio already uploaded.

The language selector sends a language hint unless set to Auto. Translate to
English uses `/audio/translations`; enable it only with a service/model supporting
that endpoint. Automatic language detection and supported languages depend on
the selected service/model.

History retries and `--transcribe-file` use the selected speech provider too.
With external mode enabled, local-only CLI overrides `--model` and
`--device-index` are rejected; disable external mode before using these options.
