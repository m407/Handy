//! OpenAI-compatible audio API, independent of the text completion client.
use crate::settings::SpeechProviderSettings;
use anyhow::{bail, Context, Result};
use reqwest::multipart::{Form, Part};
use std::io::Cursor;
use std::time::Duration;

pub fn validate(provider: &SpeechProviderSettings) -> Result<()> {
    let url = reqwest::Url::parse(provider.base_url.trim())
        .map_err(|_| anyhow::anyhow!("Invalid speech provider URL"))?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        bail!("Speech provider URL must use HTTP or HTTPS");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Speech provider URL must not contain credentials, query parameters or fragments");
    }
    if provider.model.trim().is_empty() {
        bail!("Speech recognition model is required");
    }
    Ok(())
}

fn encode_wav(audio: &[f32]) -> Result<Vec<u8>> {
    // Keep below the common 25 MB audio API limit; never truncate a recording.
    if audio.len() > (25_000_000 - 44) / 2 {
        bail!("Recording exceeds the external speech provider's 25 MB limit");
    }
    let mut buffer = Cursor::new(Vec::with_capacity(44 + audio.len() * 2));
    {
        let mut writer = hound::WavWriter::new(
            &mut buffer,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )?;
        for &sample in audio {
            writer.write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
        }
        writer.finalize()?;
    }
    Ok(buffer.into_inner())
}

/// Drop the entire HTTP operation on cancellation, including upload, waiting
/// for headers and reading the response body. A queued operation checks the
/// caller's original cancellation generation before sending any audio.
pub async fn transcribe_cancellable(
    provider: &SpeechProviderSettings,
    audio: &[f32],
    language: &str,
    translate: bool,
    is_cancelled: impl Fn() -> bool,
) -> Result<String> {
    let operation = transcribe(provider, audio, language, translate);
    tokio::pin!(operation);
    loop {
        if is_cancelled() {
            return Err(crate::engine_supervisor::EngineError::Cancelled.into());
        }
        if let Ok(result) =
            tokio::time::timeout(Duration::from_millis(25), operation.as_mut()).await
        {
            // Cancellation wins even if the response became ready together
            // with the signal, so no stale transcript reaches post-processing.
            if is_cancelled() {
                return Err(crate::engine_supervisor::EngineError::Cancelled.into());
            }
            return result;
        }
    }
}

async fn transcribe(
    provider: &SpeechProviderSettings,
    audio: &[f32],
    language: &str,
    translate: bool,
) -> Result<String> {
    validate(provider)?;
    if audio.is_empty() {
        return Ok(String::new());
    }
    let operation = if translate {
        "translations"
    } else {
        "transcriptions"
    };
    let endpoint = format!(
        "{}/audio/{}",
        provider.base_url.trim().trim_end_matches('/'),
        operation
    );
    let part = Part::bytes(encode_wav(audio)?)
        .file_name("recording.wav")
        .mime_str("audio/wav")?;
    let mut form = Form::new()
        .part("file", part)
        .text("model", provider.model.trim().to_owned())
        .text("response_format", "json");
    if !translate && !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_owned());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut request = client.post(endpoint).multipart(form);
    if !provider.api_key.trim().is_empty() {
        request = request.bearer_auth(provider.api_key.trim());
    }
    let response = request.send().await.map_err(|_| {
        anyhow::anyhow!("Speech provider request failed (connection error or timeout)")
    })?;
    if !response.status().is_success() {
        // Provider responses can contain audio transcripts or credentials; don't log them.
        bail!(
            "Speech provider returned HTTP {}",
            response.status().as_u16()
        );
    }
    #[derive(serde::Deserialize)]
    struct Transcript {
        text: String,
    }
    let result = response
        .json::<Transcript>()
        .await
        .context("Speech provider returned an invalid transcription response")?;
    Ok(result.text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn serve_once(status: &str, body: &str) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (url, task)
    }

    /// A server that receives the whole upload, then stalls either before
    /// headers or halfway through the JSON body until the client disconnects.
    async fn stalled_server(
        send_headers: bool,
    ) -> (
        String,
        tokio::sync::oneshot::Receiver<()>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let (ready, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0, "client disconnected before uploading");
                request.extend_from_slice(&buffer[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if send_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"text\":\"").await.unwrap();
            }
            ready.send(()).unwrap();
            let mut byte = [0];
            match socket.read(&mut byte).await {
                Ok(0) | Err(_) => {}
                Ok(_) => panic!("unexpected data after upload"),
            }
        });
        (url, received, server)
    }

    async fn assert_stalled_request_cancels(send_headers: bool) {
        use crate::engine_supervisor::{EngineError, EngineSupervisor};
        use std::sync::Arc;
        let engine = Arc::new(EngineSupervisor::new(false));
        let mark = engine.cancel_mark();
        let (base_url, received, server) = stalled_server(send_headers).await;
        let provider = SpeechProviderSettings {
            base_url,
            ..Default::default()
        };
        let worker_engine = Arc::clone(&engine);
        // Exercise the same blocking-task bridge used by the recording path.
        let worker = tokio::task::spawn_blocking(move || {
            tauri::async_runtime::block_on(transcribe_cancellable(
                &provider,
                &[0.0],
                "auto",
                false,
                || worker_engine.was_cancelled_since(mark),
            ))
        });
        tokio::time::timeout(Duration::from_secs(2), received)
            .await
            .unwrap()
            .unwrap();
        engine.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .expect("cancel must release the blocking worker without waiting for the provider")
            .unwrap()
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<EngineError>(),
            Some(EngineError::Cancelled)
        ));
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("dropping the request must close the stalled connection")
            .unwrap();

        // An old cancellation must not poison the next recording.
        let next_mark = engine.cancel_mark();
        let (base_url, server) = serve_once("200 OK", r#"{"text":"next recording"}"#).await;
        let provider = SpeechProviderSettings {
            base_url,
            ..Default::default()
        };
        let text = transcribe_cancellable(&provider, &[0.0], "auto", false, || {
            engine.was_cancelled_since(next_mark)
        })
        .await
        .unwrap();
        assert_eq!(text, "next recording");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_releases_worker_waiting_for_headers() {
        assert_stalled_request_cancels(false).await;
    }

    #[tokio::test]
    async fn cancellation_releases_worker_waiting_for_body() {
        assert_stalled_request_cancels(true).await;
    }

    #[tokio::test]
    async fn queued_request_cancelled_before_start_never_connects() {
        use crate::engine_supervisor::{EngineError, EngineSupervisor};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = SpeechProviderSettings {
            base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
            ..Default::default()
        };
        let engine = EngineSupervisor::new(false);
        let mark = engine.cancel_mark();
        engine.cancel();
        let error = transcribe_cancellable(&provider, &[0.0], "auto", false, || {
            engine.was_cancelled_since(mark)
        })
        .await
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<EngineError>(),
            Some(EngineError::Cancelled)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn sends_audio_model_language_and_independent_credentials() {
        let (base_url, server) = serve_once("200 OK", r#"{"text":"  recognized speech  "}"#).await;
        let provider = SpeechProviderSettings {
            enabled: true,
            base_url,
            api_key: "speech-only-key".into(),
            model: "whisper-large-v3".into(),
        };
        let text = transcribe(&provider, &[0.0, 0.5], "ru", false)
            .await
            .unwrap();
        assert_eq!(text, "recognized speech");
        let bytes = server.await.unwrap();
        let request = String::from_utf8_lossy(&bytes);
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
        assert!(request.contains("Bearer speech-only-key"));
        assert!(request.contains("name=\"model\"\r\n\r\nwhisper-large-v3"));
        assert!(request.contains("name=\"language\"\r\n\r\nru"));
        assert!(request.contains("filename=\"recording.wav\""));
        assert!(request.contains("RIFF"));
    }

    #[tokio::test]
    async fn translations_omit_language_and_auto_omits_language() {
        for translate in [false, true] {
            let (base_url, server) = serve_once("200 OK", r#"{"text":"hello"}"#).await;
            let provider = SpeechProviderSettings {
                base_url,
                ..Default::default()
            };
            transcribe(
                &provider,
                &[0.0],
                if translate { "ru" } else { "auto" },
                translate,
            )
            .await
            .unwrap();
            let bytes = server.await.unwrap();
            let request = String::from_utf8_lossy(&bytes);
            assert!(!request.contains("name=\"language\""));
            assert!(!request.to_lowercase().contains("authorization:"));
            if translate {
                assert!(request.starts_with("POST /v1/audio/translations "));
            }
        }
    }

    #[tokio::test]
    async fn rejects_http_errors_and_malformed_responses_without_echoing_secrets() {
        for (status, body) in [
            ("401 Unauthorized", "private-provider-detail"),
            ("200 OK", r#"{"error":"private-provider-detail"}"#),
        ] {
            let (base_url, server) = serve_once(status, body).await;
            let provider = SpeechProviderSettings {
                base_url,
                ..Default::default()
            };
            let error = transcribe(&provider, &[0.0], "auto", false)
                .await
                .unwrap_err();
            assert!(!format!("{error:#}").contains("private-provider-detail"));
            server.await.unwrap();
        }
    }

    #[test]
    fn speech_settings_do_not_change_text_provider_and_old_settings_stay_local() {
        let mut settings = crate::settings::AppSettings::default();
        let previous = settings.post_process_provider_id.clone();
        settings.speech_provider.enabled = true;
        settings.speech_provider.model = "speech-model".into();
        let mut value = serde_json::to_value(&settings).unwrap();
        let restored: crate::settings::AppSettings = serde_json::from_value(value.clone()).unwrap();
        assert!(restored.speech_provider.enabled);
        assert_eq!(restored.post_process_provider_id, previous);
        value.as_object_mut().unwrap().remove("speech_provider");
        let legacy: crate::settings::AppSettings = serde_json::from_value(value).unwrap();
        assert!(!legacy.speech_provider.enabled);
    }

    #[test]
    fn wav_is_mono_16khz_pcm_and_clips_samples() {
        let bytes = encode_wav(&[-2.0, 0.0, 2.0]).unwrap();
        let mut reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(
            reader
                .samples::<i16>()
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            vec![-32767, 0, 32767]
        );
    }

    #[test]
    fn defaults_preserve_local_recognition_and_redact_credentials() {
        let mut provider = SpeechProviderSettings::default();
        assert!(!provider.enabled);
        provider.api_key = "secret-test-key".into();
        assert!(!format!("{provider:?}").contains("secret-test-key"));
        let restored: SpeechProviderSettings = serde_json::from_str("{}").unwrap();
        assert!(!restored.enabled);
    }

    #[test]
    fn validates_endpoint_and_model() {
        let mut provider = SpeechProviderSettings::default();
        assert!(validate(&provider).is_ok());
        for url in [
            "file:///tmp/audio",
            "https://user:password@example.com",
            "https://example.com?key=secret",
        ] {
            provider.base_url = url.into();
            assert!(validate(&provider).is_err());
        }
        provider.base_url = "http://localhost:8080/v1".into();
        assert!(validate(&provider).is_ok());
        provider.model = " ".into();
        assert!(validate(&provider).is_err());
    }
}
