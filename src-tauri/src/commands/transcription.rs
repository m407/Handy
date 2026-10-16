use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout};
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn set_model_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.model_unload_timeout = timeout;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn get_model_load_status(
    transcription_manager: State<Arc<TranscriptionManager>>,
) -> Result<ModelLoadStatus, String> {
    Ok(ModelLoadStatus {
        is_loaded: transcription_manager.is_model_loaded(),
        current_model: transcription_manager.get_current_model(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn unload_model_manually(
    transcription_manager: State<Arc<TranscriptionManager>>,
) -> Result<(), String> {
    transcription_manager.request_unload();
    Ok(())
}

/// Persist speech settings without changing the text improvement provider.
#[tauri::command]
#[specta::specta]
pub fn set_speech_provider(
    app: AppHandle,
    provider: crate::settings::SpeechProviderSettings,
) -> Result<(), String> {
    if provider.enabled {
        crate::speech_client::validate(&provider).map_err(|e| e.to_string())?;
    }
    let mut settings = get_settings(&app);
    if provider.enabled {
        settings.onboarding_completed = true;
    }
    settings.speech_provider = provider;
    write_settings(&app, settings);
    Ok(())
}
