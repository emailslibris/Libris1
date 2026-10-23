#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use lettre::{
    message::Mailbox, transport::smtp::authentication::Credentials, Message, SmtpTransport,
    Transport,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    webview::{PermissionKind, PermissionResponse},
    State,
};

const SMTP_KEYRING_SERVICE: &str = "br.gov.ce.crede17.libris.smtp";

#[tauri::command]
fn begin_camera_permission_request(camera_request: State<'_, Arc<AtomicBool>>) {
    camera_request.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn clear_camera_permission_request(camera_request: State<'_, Arc<AtomicBool>>) {
    camera_request.store(false, Ordering::SeqCst);
}

fn smtp_keyring_entry(school_id: &str) -> Result<Entry, String> {
    if school_id.is_empty()
        || school_id.len() > 80
        || !school_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Identificador de escola inválido.".into());
    }

    Entry::new(SMTP_KEYRING_SERVICE, &format!("school:{school_id}"))
        .map_err(|error| format!("Não foi possível acessar o cofre de credenciais: {error}"))
}

#[tauri::command]
async fn save_smtp_password(school_id: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_smtp_password_blocking(school_id, password))
        .await
        .map_err(|error| format!("Não foi possível salvar a senha SMTP: {error}"))?
}

fn save_smtp_password_blocking(school_id: String, password: String) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("Informe uma senha de aplicativo válida.".into());
    }

    smtp_keyring_entry(&school_id)?
        .set_password(&password)
        .map_err(|error| format!("Não foi possível salvar a senha no cofre do sistema: {error}"))
}

#[tauri::command]
async fn has_smtp_password(school_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || has_smtp_password_blocking(school_id))
        .await
        .map_err(|error| format!("Não foi possível consultar a senha SMTP: {error}"))?
}

fn has_smtp_password_blocking(school_id: String) -> Result<bool, String> {
    match smtp_keyring_entry(&school_id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!(
            "Não foi possível consultar o cofre de credenciais: {error}"
        )),
    }
}

#[tauri::command]
async fn delete_smtp_password(school_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_smtp_password_blocking(school_id))
        .await
        .map_err(|error| format!("Não foi possível remover a senha SMTP: {error}"))?
}

fn delete_smtp_password_blocking(school_id: String) -> Result<(), String> {
    match smtp_keyring_entry(&school_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Não foi possível remover a senha do cofre do sistema: {error}"
        )),
    }
}

#[tauri::command]
async fn send_email(
    school_id: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_username: String,
    recipient: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        send_email_blocking(
            school_id,
            smtp_host,
            smtp_port,
            smtp_username,
            recipient,
            subject,
            body,
        )
    })
    .await
    .map_err(|error| format!("O envio SMTP foi interrompido: {error}"))?
}

fn send_email_blocking(
    school_id: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_username: String,
    recipient: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    if smtp_host.is_empty()
        || smtp_host.len() > 253
        || smtp_host.chars().any(char::is_whitespace)
        || !matches!(smtp_port, 465 | 587)
    {
        return Err(
            "Host SMTP ou porta inválidos. Use a porta 465 (TLS) ou 587 (STARTTLS).".into(),
        );
    }
    if smtp_username.is_empty() || smtp_username.len() > 320 {
        return Err("Informe o e-mail institucional usado para autenticação SMTP.".into());
    }
    if recipient.is_empty() || recipient.len() > 320 {
        return Err("Informe um endereço de destinatário válido.".into());
    }
    if subject.is_empty()
        || subject.len() > 998
        || subject
            .chars()
            .any(|character| character == '\r' || character == '\n')
        || body.len() > 100_000
    {
        return Err("Assunto ou corpo do e-mail inválido.".into());
    }

    let password = smtp_keyring_entry(&school_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "Configure a senha SMTP na administração CREDE.".into(),
            other => format!("Não foi possível acessar a senha SMTP no cofre do sistema: {other}"),
        })?;
    let credentials = Credentials::new(smtp_username.clone(), password);
    let sender: Mailbox = smtp_username
        .parse()
        .map_err(|_| "O usuário SMTP precisa ser um endereço de e-mail válido.".to_string())?;
    let recipient: Mailbox = recipient
        .parse()
        .map_err(|_| "O destinatário precisa ser um endereço de e-mail válido.".to_string())?;
    let message = Message::builder()
        .from(sender)
        .to(recipient)
        .subject(subject)
        .body(body)
        .map_err(|error| format!("Não foi possível montar o e-mail: {error}"))?;

    let mailer = match smtp_port {
        465 => SmtpTransport::relay(&smtp_host),
        587 => SmtpTransport::starttls_relay(&smtp_host),
        _ => unreachable!("a porta SMTP foi validada acima"),
    }
    .map_err(|error| format!("Não foi possível configurar a conexão SMTP segura: {error}"))?
    .port(smtp_port)
    .credentials(credentials)
    .build();

    mailer
        .send(&message)
        .map_err(|error| format!("Falha no envio SMTP: {error}"))?;
    Ok(())
}

fn main() {
    let camera_request = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::clone(&camera_request))
        .invoke_handler(tauri::generate_handler![
            begin_camera_permission_request,
            clear_camera_permission_request,
            save_smtp_password,
            has_smtp_password,
            delete_smtp_password,
            send_email
        ])
        .on_permission_request(move |_, kind| match kind {
            PermissionKind::Camera if camera_request.swap(false, Ordering::SeqCst) => {
                PermissionResponse::Allow
            }
            _ => PermissionResponse::Default,
        })
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o aplicativo Libris");
}
