use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::{HeaderValue, header::ORIGIN};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};
use url::Url;

const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TARGET_DISCOVERY_INTERVAL_TICKS: u64 = 10;
const HEALTH_INTERVAL_TICKS: u64 = 60;
const MAX_IN_FLIGHT_BRIDGE_REQUESTS: usize = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionInfo {
    web_socket_debugger_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    pub web_socket_debugger_url: Option<String>,
}

pub struct CdpClient {
    port: u16,
    browser_identity: String,
    http: Client,
}

impl CdpClient {
    pub fn connect(port: u16) -> Result<Self> {
        let http = Client::builder()
            .no_proxy()
            .timeout(HTTP_TIMEOUT)
            .build()
            .context("failed to create the loopback HTTP client")?;
        let version: VersionInfo = get_json(&http, port, "/json/version")?;
        validate_debugger_url(&version.web_socket_debugger_url, port, "browser")?;
        let client = Self {
            port,
            browser_identity: version.web_socket_debugger_url,
            http,
        };
        if client.injectable_targets()?.is_empty() {
            bail!("the CDP endpoint does not expose a Codex renderer target");
        }
        Ok(client)
    }

    pub fn watch_and_inject(
        &self,
        script: &str,
        bridge_token: &str,
        running: &AtomicBool,
    ) -> Result<()> {
        let mut sessions: HashMap<String, TargetSession> = HashMap::new();
        let mut tick = 0_u64;
        let mut waiting_reported = false;
        let mut rediscover = false;

        while running.load(Ordering::SeqCst) {
            if rediscover || tick.is_multiple_of(TARGET_DISCOVERY_INTERVAL_TICKS) {
                rediscover = false;
                self.verify_browser_identity()?;
                let targets = self.injectable_targets()?;
                let active_ids: HashSet<&str> =
                    targets.iter().map(|target| target.id.as_str()).collect();
                sessions.retain(|id, session| {
                    if active_ids.contains(id.as_str()) {
                        true
                    } else {
                        session.close();
                        false
                    }
                });

                if targets.is_empty() {
                    if !waiting_reported {
                        println!("Waiting for a Codex renderer target...");
                        waiting_reported = true;
                    }
                } else {
                    waiting_reported = false;
                }

                for target in targets {
                    if sessions.contains_key(&target.id) {
                        continue;
                    }
                    match TargetSession::connect_and_install(
                        &target,
                        self.port,
                        script,
                        bridge_token,
                    ) {
                        Ok(session) => {
                            println!("Leetcodex injected into Codex target {}", target.id);
                            sessions.insert(target.id.clone(), session);
                        }
                        Err(error) => {
                            eprintln!("Could not inject target {}: {error:#}", target.id);
                        }
                    }
                }
            }

            let failed = sessions
                .iter_mut()
                .filter_map(|(id, session)| match session.pump_events() {
                    Ok(()) => None,
                    Err(error) => {
                        eprintln!("Leetcodex bridge event failed for target {id}: {error:#}");
                        Some(id.clone())
                    }
                })
                .collect::<Vec<_>>();
            for id in failed {
                if let Some(mut session) = sessions.remove(&id) {
                    session.close();
                    rediscover = true;
                }
            }

            tick += 1;
            if tick.is_multiple_of(HEALTH_INTERVAL_TICKS) {
                let unhealthy = sessions
                    .iter_mut()
                    .filter_map(|(id, session)| match session.is_healthy() {
                        Ok(true) => None,
                        Ok(false) | Err(_) => Some(id.clone()),
                    })
                    .collect::<Vec<_>>();
                for id in unhealthy {
                    if let Some(mut session) = sessions.remove(&id) {
                        let _ = session.remove_leetcodex();
                        session.close();
                        rediscover = true;
                    }
                }
            }

            thread::sleep(EVENT_POLL_INTERVAL);
        }

        for session in sessions.values_mut() {
            let _ = session.remove_leetcodex();
            session.close();
        }
        Ok(())
    }

    fn verify_browser_identity(&self) -> Result<()> {
        let version: VersionInfo = get_json(&self.http, self.port, "/json/version")?;
        validate_debugger_url(&version.web_socket_debugger_url, self.port, "browser")?;
        if version.web_socket_debugger_url != self.browser_identity {
            bail!("the CDP browser identity changed while Leetcodex was running");
        }
        Ok(())
    }

    fn injectable_targets(&self) -> Result<Vec<TargetInfo>> {
        let targets: Vec<TargetInfo> = get_json(&self.http, self.port, "/json/list")?;
        Ok(targets
            .into_iter()
            .filter(|target| is_injectable_codex_target(target, self.port))
            .collect())
    }

    pub fn renderer_diagnostic(&self, expected_version: &str) -> Value {
        let targets = match self.injectable_targets() {
            Ok(targets) => targets,
            Err(error) => {
                return json!({
                    "status": "error",
                    "detail": format!("{error:#}"),
                    "targets": [],
                });
            }
        };
        let states = targets
            .iter()
            .map(|target| match evaluate_renderer_state(target, self.port) {
                Ok(value) => classify_renderer_state(&target.id, value, expected_version),
                Err(error) => json!({
                    "targetId": target.id,
                    "status": "error",
                    "detail": format!("{error:#}"),
                }),
            })
            .collect::<Vec<_>>();
        renderer_report(states)
    }
}

struct TargetSession {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    script_identifier: Option<String>,
    bridge_dispatcher: BridgeDispatcher,
}

struct BridgeWorkerResponse {
    request_id: String,
    payload: Value,
}

struct BridgeWork {
    request_id: String,
    payload: String,
}

struct BridgeDispatcher {
    token: String,
    sender: Sender<BridgeWorkerResponse>,
    receiver: Receiver<BridgeWorkerResponse>,
    in_flight: HashSet<String>,
    draft_sender: Option<Sender<BridgeWork>>,
    draft_worker: Option<thread::JoinHandle<()>>,
}

impl BridgeDispatcher {
    fn new(token: &str) -> Result<Self> {
        let (sender, receiver) = mpsc::channel();
        let (draft_sender, draft_receiver) = mpsc::channel::<BridgeWork>();
        let draft_token = token.to_string();
        let draft_response_sender = sender.clone();
        let draft_worker = thread::Builder::new()
            .name("leetcodex-drafts".to_string())
            .spawn(move || {
                for work in draft_receiver {
                    dispatch_bridge_work(work, draft_token.as_str(), &draft_response_sender);
                }
            })
            .context("failed to start the native draft worker")?;
        Ok(Self {
            token: token.to_string(),
            sender,
            receiver,
            in_flight: HashSet::new(),
            draft_sender: Some(draft_sender),
            draft_worker: Some(draft_worker),
        })
    }

    fn enqueue(
        &mut self,
        request_id: String,
        path: Option<&str>,
        payload: String,
    ) -> Option<BridgeWorkerResponse> {
        if self.in_flight.contains(&request_id) {
            return Some(bridge_error_response(
                request_id,
                "duplicate bridge request id",
            ));
        }
        if self.in_flight.len() >= MAX_IN_FLIGHT_BRIDGE_REQUESTS {
            return Some(bridge_error_response(
                request_id,
                "too many concurrent bridge requests",
            ));
        }

        self.in_flight.insert(request_id.clone());
        let work = BridgeWork {
            request_id: request_id.clone(),
            payload,
        };
        if path.is_some_and(|value| value.starts_with("/api/draft/")) {
            if self
                .draft_sender
                .as_ref()
                .is_none_or(|sender| sender.send(work).is_err())
            {
                self.in_flight.remove(&request_id);
                return Some(bridge_error_response(
                    request_id,
                    "native draft worker is unavailable",
                ));
            }
            return None;
        }

        let token = self.token.clone();
        let sender = self.sender.clone();
        let spawn_result = thread::Builder::new()
            .name("leetcodex-bridge".to_string())
            .spawn(move || dispatch_bridge_work(work, token.as_str(), &sender));
        if let Err(error) = spawn_result {
            self.in_flight.remove(&request_id);
            return Some(bridge_error_response(
                request_id,
                &format!("failed to start bridge worker: {error}"),
            ));
        }
        None
    }

    fn drain(&mut self) -> Result<Vec<BridgeWorkerResponse>> {
        let mut responses = Vec::new();
        loop {
            match self.receiver.try_recv() {
                Ok(response) => {
                    self.in_flight.remove(&response.request_id);
                    responses.push(response);
                }
                Err(TryRecvError::Empty) => return Ok(responses),
                Err(TryRecvError::Disconnected) => {
                    bail!("bridge worker response channel disconnected")
                }
            }
        }
    }
}

impl Drop for BridgeDispatcher {
    fn drop(&mut self) {
        self.draft_sender.take();
        if let Some(worker) = self.draft_worker.take() {
            let _ = worker.join();
        }
    }
}

fn dispatch_bridge_work(work: BridgeWork, token: &str, sender: &Sender<BridgeWorkerResponse>) {
    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::bridge::dispatch_payload(&work.payload, token)
    }))
    .unwrap_or_else(|_| json!({ "ok": false, "error": "bridge worker failed unexpectedly" }));
    let _ = sender.send(BridgeWorkerResponse {
        request_id: work.request_id,
        payload: response,
    });
}

fn bridge_error_response(request_id: String, message: &str) -> BridgeWorkerResponse {
    BridgeWorkerResponse {
        request_id,
        payload: json!({ "ok": false, "error": message }),
    }
}

impl TargetSession {
    fn connect_and_install(
        target: &TargetInfo,
        port: u16,
        script: &str,
        bridge_token: &str,
    ) -> Result<Self> {
        let socket = connect_target_socket(target, port)?;

        let mut session = Self {
            socket,
            next_id: 1,
            script_identifier: None,
            bridge_dispatcher: BridgeDispatcher::new(bridge_token)?,
        };
        session.command("Runtime.addBinding", json!({ "name": "leetcodexBridge" }))?;
        let registration = session.command(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )?;
        let identifier = registration
            .pointer("/result/identifier")
            .and_then(Value::as_str)
            .context("CDP did not return a new-document script identifier")?
            .to_string();
        session.script_identifier = Some(identifier);
        if let Err(error) = session.command(
            "Runtime.evaluate",
            json!({
                "expression": script,
                "awaitPromise": true,
                "returnByValue": true,
                "allowUnsafeEvalBlockedByCSP": true
            }),
        ) {
            let _ = session.unregister_new_document_script();
            return Err(error);
        }
        Ok(session)
    }

    fn is_healthy(&mut self) -> Result<bool> {
        let response = self.command(
            "Runtime.evaluate",
            json!({
                "expression": "typeof window.__LEETCODEX__?.ensure === 'function' && typeof window.__LEETCODEX__?.destroy === 'function' && typeof window.__COTYPEX__?.ensure === 'function' && typeof window.__COTYPEX__?.destroy === 'function'",
                "returnByValue": true
            }),
        )?;
        Ok(response
            .pointer("/result/result/value")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    fn remove_leetcodex(&mut self) -> Result<()> {
        let unregister_result = self.unregister_new_document_script();
        let cleanup_result = self.command(
            "Runtime.evaluate",
            json!({
                "expression": "(() => { const typing = window.__COTYPEX__?.destroy?.(); const leetcode = window.__LEETCODEX__?.destroy?.(); return typing !== false && leetcode !== false; })()",
                "returnByValue": true
            }),
        );
        unregister_result?;
        cleanup_result?;
        Ok(())
    }

    fn unregister_new_document_script(&mut self) -> Result<()> {
        let Some(identifier) = self.script_identifier.take() else {
            return Ok(());
        };
        self.command(
            "Page.removeScriptToEvaluateOnNewDocument",
            json!({ "identifier": identifier }),
        )?;
        Ok(())
    }

    fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        self.flush_bridge_responses()?;
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .with_context(|| format!("failed to send CDP command {method}"))?;

        loop {
            let message = self
                .socket
                .read()
                .with_context(|| format!("failed to read CDP response for {method}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let response: Value =
                serde_json::from_str(text.as_str()).context("CDP returned invalid JSON")?;
            if response.get("method").and_then(Value::as_str) == Some("Runtime.bindingCalled") {
                self.handle_binding_event(&response)?;
                continue;
            }
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                bail!("CDP command {method} failed: {error}");
            }
            if let Some(exception) = response.pointer("/result/exceptionDetails") {
                bail!("CDP evaluation raised an exception: {exception}");
            }
            return Ok(response);
        }
    }

    fn pump_events(&mut self) -> Result<()> {
        self.flush_bridge_responses()?;
        self.set_nonblocking(true)?;
        let result = (|| {
            loop {
                match self.socket.read() {
                    Ok(Message::Text(text)) => {
                        let event: Value = serde_json::from_str(text.as_str())
                            .context("CDP returned invalid event JSON")?;
                        if event.get("method").and_then(Value::as_str)
                            == Some("Runtime.bindingCalled")
                        {
                            self.handle_binding_event(&event)?;
                        }
                    }
                    Ok(_) => continue,
                    Err(tungstenite::Error::Io(error))
                        if error.kind() == io::ErrorKind::WouldBlock =>
                    {
                        break;
                    }
                    Err(tungstenite::Error::ConnectionClosed) => {
                        bail!("Codex CDP target closed the bridge connection")
                    }
                    Err(error) => return Err(error).context("failed to read a CDP bridge event"),
                }
            }
            Ok(())
        })();
        let restore = self.set_nonblocking(false);
        result.and(restore)?;
        self.flush_bridge_responses()
    }

    fn handle_binding_event(&mut self, event: &Value) -> Result<()> {
        if event.pointer("/params/name").and_then(Value::as_str) != Some("leetcodexBridge") {
            return Ok(());
        }
        let payload = event
            .pointer("/params/payload")
            .and_then(Value::as_str)
            .context("Leetcodex binding event has no payload")?;
        if payload.len() > crate::bridge::MAX_BRIDGE_PAYLOAD_BYTES {
            bail!("Leetcodex bridge payload exceeded the allowed size");
        }
        let request: Value =
            serde_json::from_str(payload).context("invalid bridge request JSON")?;
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 80
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
            .context("bridge request id is required")?;
        if let Some(response) = self.bridge_dispatcher.enqueue(
            request_id.to_string(),
            request.get("path").and_then(Value::as_str),
            payload.to_string(),
        ) {
            self.send_bridge_response(response)?;
        }
        Ok(())
    }

    fn flush_bridge_responses(&mut self) -> Result<()> {
        for response in self.bridge_dispatcher.drain()? {
            self.send_bridge_response(response)?;
        }
        Ok(())
    }

    fn send_bridge_response(&mut self, response: BridgeWorkerResponse) -> Result<()> {
        let response_payload = bounded_bridge_response_payload(response.payload)?;
        let expression = format!(
            "window.__LEETCODEX_BRIDGE_RESOLVE__?.({}, {})",
            serde_json::to_string(&response.request_id)?,
            response_payload
        );
        self.send_command_without_waiting(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": false }),
        )
    }

    fn send_command_without_waiting(&mut self, method: &str, params: Value) -> Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .with_context(|| format!("failed to send CDP command {method}"))
    }

    fn set_nonblocking(&mut self, nonblocking: bool) -> Result<()> {
        let MaybeTlsStream::Plain(stream) = self.socket.get_mut() else {
            bail!("loopback CDP unexpectedly negotiated TLS");
        };
        stream.set_nonblocking(nonblocking)?;
        if !nonblocking {
            stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
        }
        Ok(())
    }

    fn close(&mut self) {
        let _ = self.socket.close(None);
    }
}

fn connect_target_socket(
    target: &TargetInfo,
    port: u16,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>> {
    let debugger_url = target
        .web_socket_debugger_url
        .as_deref()
        .context("Codex target does not expose a debugger WebSocket")?;
    validate_debugger_url(debugger_url, port, "page")?;
    let mut request = debugger_url
        .into_client_request()
        .context("failed to build the CDP WebSocket request")?;
    request.headers_mut().insert(
        ORIGIN,
        HeaderValue::from_str(&format!("http://127.0.0.1:{port}"))?,
    );
    let (mut socket, _) = connect(request).context("failed to connect to the Codex CDP target")?;
    set_socket_timeouts(&mut socket)?;
    Ok(socket)
}

fn evaluate_renderer_state(target: &TargetInfo, port: u16) -> Result<Value> {
    let mut socket = connect_target_socket(target, port)?;
    socket.send(Message::Text(
        json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": r#"(() => {
                  const api = window.__LEETCODEX__;
                  const typing = window.__COTYPEX__;
                  const diagnostic = typeof api?.diagnostic === 'function' ? api.diagnostic() : null;
                  return {
                    injected: typeof api?.ensure === 'function' && typeof api?.destroy === 'function',
                    version: typeof api?.version === 'string' ? api.version : null,
                    active: api?.active === true,
                    panelCount: document.querySelectorAll('.leetcodex-panel').length,
                    editorCount: document.querySelectorAll('.cm-editor').length,
                    pendingBridge: Number.isSafeInteger(diagnostic?.pendingBridge) ? diagnostic.pendingBridge : null,
                    pendingBridgeOldestMs: Number.isSafeInteger(diagnostic?.pendingBridgeOldestMs)
                      ? diagnostic.pendingBridgeOldestMs
                      : null,
                    staleBridge: Number.isSafeInteger(diagnostic?.staleBridge)
                      ? diagnostic.staleBridge
                      : null,
                    typingInjected: typeof typing?.ensure === 'function' && typeof typing?.destroy === 'function',
                    typingVersion: typeof typing?.version === 'string' ? typing.version : null,
                    typingActive: typing?.active === true,
                    typingHudCount: document.querySelectorAll('.cotypex-hud').length,
                    typingOverlayCount: document.querySelectorAll('.cotypex-overlay').length,
                    typingEditorCount: document.querySelectorAll('[data-cotypex-editor="true"]').length
                  };
                })()"#,
                "returnByValue": true
            }
        })
        .to_string()
        .into(),
    ))?;
    loop {
        let message = socket
            .read()
            .context("Codex renderer stopped responding to the diagnostic")?;
        let Message::Text(text) = message else {
            continue;
        };
        let response: Value = serde_json::from_str(text.as_str())
            .context("Codex renderer returned invalid diagnostic JSON")?;
        if response.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if let Some(error) = response.get("error") {
            bail!("renderer diagnostic command failed: {error}");
        }
        if let Some(exception) = response.pointer("/result/exceptionDetails") {
            bail!("renderer diagnostic raised an exception: {exception}");
        }
        return response
            .pointer("/result/result/value")
            .cloned()
            .context("renderer diagnostic returned no value");
    }
}

fn classify_renderer_state(target_id: &str, value: Value, expected_version: &str) -> Value {
    let injected = value.get("injected").and_then(Value::as_bool) == Some(true);
    let version = value.get("version").and_then(Value::as_str);
    let active = value.get("active").and_then(Value::as_bool) == Some(true);
    let panel_count = value.get("panelCount").and_then(Value::as_u64).unwrap_or(0);
    let editor_count = value
        .get("editorCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let pending_bridge = value.get("pendingBridge").and_then(Value::as_u64);
    let pending_bridge_oldest_ms = value.get("pendingBridgeOldestMs").and_then(Value::as_u64);
    let pending_bridge_oldest_is_null = value
        .get("pendingBridgeOldestMs")
        .is_some_and(Value::is_null);
    let stale_bridge = value.get("staleBridge").and_then(Value::as_u64);
    let typing_injected = value.get("typingInjected").and_then(Value::as_bool) == Some(true);
    let typing_version = value.get("typingVersion").and_then(Value::as_str);
    let typing_active = value.get("typingActive").and_then(Value::as_bool) == Some(true);
    let typing_hud_count = value
        .get("typingHudCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let typing_overlay_count = value
        .get("typingOverlayCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let typing_editor_count = value
        .get("typingEditorCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let bridge_diagnostic_valid =
        pending_bridge
            .zip(stale_bridge)
            .is_some_and(|(pending, stale)| {
                stale <= pending
                    && if pending == 0 {
                        pending_bridge_oldest_is_null
                    } else {
                        pending_bridge_oldest_ms.is_some()
                    }
            });
    let leetcode_ready = active && panel_count == 1 && editor_count == 1;
    let typing_ready = typing_active
        && typing_hud_count == 1
        && typing_overlay_count == 1
        && typing_editor_count == 1;
    let inactive_surfaces = panel_count == 0
        && editor_count == 0
        && typing_hud_count == 0
        && typing_overlay_count == 0
        && typing_editor_count == 0;
    let (status, mode) = if !injected {
        ("not_injected", None)
    } else if !typing_injected {
        ("typing_not_injected", None)
    } else if version != Some(expected_version) || typing_version != Some(expected_version) {
        ("version_mismatch", None)
    } else if !bridge_diagnostic_valid {
        ("degraded", None)
    } else if stale_bridge.is_some_and(|count| count > 0) {
        ("bridge_stalled", None)
    } else if leetcode_ready
        && !typing_active
        && typing_hud_count == 0
        && typing_overlay_count == 0
        && typing_editor_count == 0
    {
        ("active", Some("leetcode"))
    } else if !active && panel_count == 0 && editor_count == 0 && typing_ready {
        ("active", Some("typing"))
    } else if !active && !typing_active && inactive_surfaces {
        ("inactive", None)
    } else {
        ("degraded", None)
    };
    json!({
        "targetId": target_id,
        "status": status,
        "mode": mode,
        "version": version,
        "active": active,
        "panelCount": panel_count,
        "editorCount": editor_count,
        "pendingBridge": pending_bridge,
        "pendingBridgeOldestMs": pending_bridge_oldest_ms,
        "staleBridge": stale_bridge,
        "typingInjected": typing_injected,
        "typingVersion": typing_version,
        "typingActive": typing_active,
        "typingHudCount": typing_hud_count,
        "typingOverlayCount": typing_overlay_count,
        "typingEditorCount": typing_editor_count,
    })
}

fn renderer_report(targets: Vec<Value>) -> Value {
    let has_problem = targets.iter().any(|target| {
        matches!(
            target.get("status").and_then(Value::as_str),
            Some(
                "error"
                    | "version_mismatch"
                    | "degraded"
                    | "bridge_stalled"
                    | "typing_not_injected"
            )
        )
    });
    let status = if has_problem {
        "degraded"
    } else if targets
        .iter()
        .any(|target| target.get("status").and_then(Value::as_str) == Some("active"))
    {
        "active"
    } else if !targets.is_empty()
        && targets
            .iter()
            .all(|target| target.get("status").and_then(Value::as_str) == Some("inactive"))
    {
        "inactive"
    } else {
        "not_injected"
    };
    json!({
        "status": status,
        "targetCount": targets.len(),
        "targets": targets,
    })
}

fn bounded_bridge_response_payload(payload: Value) -> Result<String> {
    let serialized = serde_json::to_string(&payload)?;
    if serialized.len() <= crate::bridge::MAX_BRIDGE_PAYLOAD_BYTES {
        return Ok(serialized);
    }
    Ok(serde_json::to_string(&json!({
        "ok": false,
        "error": "bridge response exceeds the 1500000-byte limit"
    }))?)
}

fn get_json<T: for<'de> Deserialize<'de>>(client: &Client, port: u16, path: &str) -> Result<T> {
    let url = format!("http://127.0.0.1:{port}{path}");
    client
        .get(&url)
        .send()
        .with_context(|| format!("failed to reach {url}"))?
        .error_for_status()
        .with_context(|| format!("CDP endpoint rejected {path}"))?
        .json::<T>()
        .with_context(|| format!("CDP endpoint returned invalid JSON for {path}"))
}

fn is_injectable_codex_target(target: &TargetInfo, port: u16) -> bool {
    if target.target_type != "page" || target.web_socket_debugger_url.is_none() {
        return false;
    }
    if target.url.to_ascii_lowercase().contains("avatar-overlay") {
        return false;
    }
    let title = target.title.trim().to_ascii_lowercase();
    let url = target.url.trim().to_ascii_lowercase();
    let looks_like_codex = url.starts_with("app://")
        || title == "codex"
        || title == "chatgpt"
        || url.starts_with("https://chatgpt.com/")
        || url == "https://chatgpt.com";
    looks_like_codex
        && target
            .web_socket_debugger_url
            .as_deref()
            .is_some_and(|value| validate_debugger_url(value, port, "page").is_ok())
}

fn validate_debugger_url(value: &str, port: u16, target_kind: &str) -> Result<()> {
    let url = Url::parse(value).context("CDP returned an invalid WebSocket URL")?;
    if url.scheme() != "ws"
        || url.port() != Some(port)
        || url.username() != ""
        || url.password().is_some()
    {
        bail!("CDP WebSocket URL has an unexpected origin");
    }
    let host = url.host_str().context("CDP WebSocket URL has no host")?;
    let ip: IpAddr = host
        .trim_matches(['[', ']'])
        .parse()
        .context("CDP WebSocket host is not an IP address")?;
    if !ip.is_loopback() {
        bail!("CDP WebSocket is not bound to a loopback address");
    }
    let expected_prefix = format!("/devtools/{target_kind}/");
    if !url.path().starts_with(&expected_prefix)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("CDP WebSocket path does not identify a {target_kind} target");
    }
    Ok(())
}

fn set_socket_timeouts(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<()> {
    let MaybeTlsStream::Plain(stream) = socket.get_mut() else {
        bail!("loopback CDP unexpectedly negotiated TLS");
    };
    stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    Ok(())
}

pub fn endpoint_is_available(port: u16) -> bool {
    CdpClient::connect(port).is_ok()
}

pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn target(url: &str, websocket: &str) -> TargetInfo {
        TargetInfo {
            id: "page-1".to_string(),
            target_type: "page".to_string(),
            title: "Codex".to_string(),
            url: url.to_string(),
            web_socket_debugger_url: Some(websocket.to_string()),
        }
    }

    #[test]
    fn accepts_loopback_page_target() {
        let item = target(
            "app://-/index.html",
            "ws://127.0.0.1:9337/devtools/page/page-1",
        );
        assert!(is_injectable_codex_target(&item, 9337));
    }

    #[test]
    fn renderer_state_requires_matching_version_and_exactly_one_active_editor() {
        let healthy_value = json!({
            "injected": true,
            "version": "0.2.47",
            "active": true,
            "panelCount": 1,
            "editorCount": 1,
            "pendingBridge": 0,
            "pendingBridgeOldestMs": null,
            "staleBridge": 0,
            "typingInjected": true,
            "typingVersion": "0.2.47",
            "typingActive": false,
            "typingHudCount": 0,
            "typingOverlayCount": 0,
            "typingEditorCount": 0,
        });
        let healthy = classify_renderer_state("page-1", healthy_value.clone(), "0.2.47");
        assert_eq!(healthy["status"], "active");
        assert_eq!(healthy["mode"], "leetcode");
        assert_eq!(healthy["pendingBridge"], 0);

        let mut duplicate_value = healthy_value.clone();
        duplicate_value["panelCount"] = json!(2);
        let duplicate = classify_renderer_state("page-1", duplicate_value, "0.2.47");
        assert_eq!(duplicate["status"], "degraded");

        let mut mismatch_value = healthy_value.clone();
        mismatch_value["typingVersion"] = json!("0.2.46");
        let mismatch = classify_renderer_state("page-1", mismatch_value, "0.2.47");
        assert_eq!(mismatch["status"], "version_mismatch");

        let mut pending_value = healthy_value.clone();
        pending_value["pendingBridge"] = json!(1);
        pending_value["pendingBridgeOldestMs"] = json!(500);
        let pending = classify_renderer_state("page-1", pending_value, "0.2.47");
        assert_eq!(pending["status"], "active");

        let mut stalled_value = healthy_value.clone();
        stalled_value["pendingBridge"] = json!(1);
        stalled_value["pendingBridgeOldestMs"] = json!(22_001);
        stalled_value["staleBridge"] = json!(1);
        let stalled = classify_renderer_state("page-1", stalled_value, "0.2.47");
        assert_eq!(stalled["status"], "bridge_stalled");

        let mut legacy_value = healthy_value.clone();
        legacy_value
            .as_object_mut()
            .unwrap()
            .remove("typingInjected");
        let legacy = classify_renderer_state("page-1", legacy_value, "0.2.47");
        assert_eq!(legacy["status"], "typing_not_injected");

        let mut typing_value = healthy_value.clone();
        typing_value["active"] = json!(false);
        typing_value["panelCount"] = json!(0);
        typing_value["editorCount"] = json!(0);
        typing_value["typingActive"] = json!(true);
        typing_value["typingHudCount"] = json!(1);
        typing_value["typingOverlayCount"] = json!(1);
        typing_value["typingEditorCount"] = json!(1);
        let typing = classify_renderer_state("page-1", typing_value, "0.2.47");
        assert_eq!(typing["status"], "active");
        assert_eq!(typing["mode"], "typing");

        let mut conflicting_value = healthy_value;
        conflicting_value["typingActive"] = json!(true);
        conflicting_value["typingHudCount"] = json!(1);
        conflicting_value["typingOverlayCount"] = json!(1);
        conflicting_value["typingEditorCount"] = json!(1);
        let conflicting = classify_renderer_state("page-1", conflicting_value, "0.2.47");
        assert_eq!(conflicting["status"], "degraded");

        let legacy = classify_renderer_state(
            "page-1",
            json!({
                "injected": true,
                "version": "0.2.47",
                "active": true,
                "panelCount": 1,
                "editorCount": 1,
                "pendingBridge": 0,
            }),
            "0.2.47",
        );
        assert_eq!(legacy["status"], "typing_not_injected");
    }

    #[test]
    fn renderer_report_propagates_target_health() {
        let active = json!({ "targetId": "page-1", "status": "active" });
        assert_eq!(renderer_report(vec![active.clone()])["status"], "active");
        assert_eq!(
            renderer_report(vec![json!({ "targetId": "page-1", "status": "inactive" })])["status"],
            "inactive"
        );
        assert_eq!(
            renderer_report(vec![
                active,
                json!({ "targetId": "page-2", "status": "error" })
            ])["status"],
            "degraded"
        );
        assert_eq!(renderer_report(Vec::new())["status"], "not_injected");
        assert_eq!(
            renderer_report(vec![
                json!({ "targetId": "page-1", "status": "bridge_stalled" })
            ])["status"],
            "degraded"
        );
    }

    #[test]
    fn rejects_non_loopback_websocket() {
        let item = target(
            "app://-/index.html",
            "ws://192.168.1.10:9337/devtools/page/page-1",
        );
        assert!(!is_injectable_codex_target(&item, 9337));
    }

    #[test]
    fn rejects_avatar_overlay() {
        let item = target(
            "app://-/index.html?initialRoute=/avatar-overlay",
            "ws://127.0.0.1:9337/devtools/page/page-1",
        );
        assert!(!is_injectable_codex_target(&item, 9337));
    }

    #[test]
    fn bridge_dispatch_runs_on_a_worker_and_returns_structured_errors() {
        let mut dispatcher = BridgeDispatcher::new("expected-token").unwrap();
        let payload = json!({
            "id": "request-1",
            "token": "wrong-token",
            "path": "/api/status",
            "method": "POST",
            "body": { "site": "global" }
        });
        assert!(
            dispatcher
                .enqueue(
                    "request-1".to_string(),
                    Some("/api/status"),
                    payload.to_string(),
                )
                .is_none()
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let response = loop {
            let mut responses = dispatcher.drain().unwrap();
            if let Some(response) = responses.pop() {
                break response;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "bridge worker timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(response.request_id, "request-1");
        assert_eq!(response.payload["ok"], false);
        assert_eq!(response.payload["error"], "invalid bridge token");
        assert!(dispatcher.in_flight.is_empty());
    }

    #[test]
    fn bridge_dispatch_rejects_duplicates_and_bounds_concurrency() {
        let mut dispatcher = BridgeDispatcher::new("expected-token").unwrap();
        let payload = "{".repeat(crate::bridge::MAX_BRIDGE_PAYLOAD_BYTES);
        for index in 0..MAX_IN_FLIGHT_BRIDGE_REQUESTS {
            assert!(
                dispatcher
                    .enqueue(
                        format!("request-{index}"),
                        Some("/api/status"),
                        payload.clone(),
                    )
                    .is_none()
            );
        }
        let duplicate = dispatcher
            .enqueue(
                "request-0".to_string(),
                Some("/api/status"),
                payload.clone(),
            )
            .expect("duplicate request should be rejected immediately");
        assert_eq!(duplicate.payload["error"], "duplicate bridge request id");
        let overloaded = dispatcher
            .enqueue("request-overload".to_string(), Some("/api/status"), payload)
            .expect("overloaded request should be rejected immediately");
        assert_eq!(
            overloaded.payload["error"],
            "too many concurrent bridge requests"
        );
    }

    #[test]
    fn native_draft_bridge_work_completes_in_arrival_order() {
        let mut dispatcher = BridgeDispatcher::new("expected-token").unwrap();
        for index in 0..4 {
            let payload = json!({
                "id": format!("draft-{index}"),
                "token": "wrong-token",
                "path": "/api/draft/save",
                "method": "POST",
                "body": {}
            });
            assert!(
                dispatcher
                    .enqueue(
                        format!("draft-{index}"),
                        Some("/api/draft/save"),
                        payload.to_string(),
                    )
                    .is_none()
            );
        }

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut responses = Vec::new();
        while responses.len() < 4 {
            responses.extend(dispatcher.drain().unwrap());
            assert!(
                std::time::Instant::now() < deadline,
                "native draft worker timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            responses
                .iter()
                .map(|response| response.request_id.as_str())
                .collect::<Vec<_>>(),
            vec!["draft-0", "draft-1", "draft-2", "draft-3"]
        );
    }

    #[test]
    fn bridge_response_payloads_are_bounded_before_renderer_evaluation() {
        let allowed =
            bounded_bridge_response_payload(json!({ "ok": true, "data": "small" })).unwrap();
        assert!(allowed.contains("small"));

        let oversized = bounded_bridge_response_payload(json!({
            "ok": true,
            "data": "x".repeat(crate::bridge::MAX_BRIDGE_PAYLOAD_BYTES)
        }))
        .unwrap();
        assert!(oversized.len() < 200);
        assert!(oversized.contains("bridge response exceeds"));
        assert!(!oversized.contains(&"x".repeat(1_000)));
    }

    #[test]
    fn target_session_runs_the_complete_injection_lifecycle() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let expected = [
                "Runtime.addBinding",
                "Page.addScriptToEvaluateOnNewDocument",
                "Runtime.evaluate",
                "Runtime.evaluate",
                "Page.removeScriptToEvaluateOnNewDocument",
                "Runtime.evaluate",
            ];
            for (index, method) in expected.into_iter().enumerate() {
                let Message::Text(text) = socket.read().unwrap() else {
                    panic!("expected a text CDP command");
                };
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(request["method"], method);
                if index == 3 {
                    assert_eq!(
                        request["params"]["expression"],
                        "typeof window.__LEETCODEX__?.ensure === 'function' && typeof window.__LEETCODEX__?.destroy === 'function' && typeof window.__COTYPEX__?.ensure === 'function' && typeof window.__COTYPEX__?.destroy === 'function'"
                    );
                }
                if index == 5 {
                    assert_eq!(
                        request["params"]["expression"],
                        "(() => { const typing = window.__COTYPEX__?.destroy?.(); const leetcode = window.__LEETCODEX__?.destroy?.(); return typing !== false && leetcode !== false; })()"
                    );
                }
                let id = request["id"].as_u64().unwrap();
                let result = if index == 1 {
                    json!({ "identifier": "script-1" })
                } else if index == 3 {
                    json!({ "result": { "value": true } })
                } else {
                    json!({ "result": {} })
                };
                let response = json!({ "id": id, "result": result });
                socket
                    .send(Message::Text(response.to_string().into()))
                    .unwrap();
            }
            let _ = socket.close(None);
        });

        let target = target(
            "app://-/index.html",
            &format!("ws://127.0.0.1:{port}/devtools/page/page-1"),
        );
        let mut session =
            TargetSession::connect_and_install(&target, port, "window.test = true;", "test-token")
                .expect("the simulated CDP target should accept injection");
        assert!(session.is_healthy().unwrap());
        session.remove_leetcodex().unwrap();
        session.close();
        server.join().unwrap();
    }

    #[test]
    fn closed_renderer_socket_fails_the_event_pump_immediately() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            for index in 0..3 {
                let Message::Text(text) = socket.read().unwrap() else {
                    panic!("expected an installation command");
                };
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                let id = request["id"].as_u64().unwrap();
                let result = if index == 1 {
                    json!({ "identifier": "script-closed" })
                } else {
                    json!({ "result": {} })
                };
                socket
                    .send(Message::Text(
                        json!({ "id": id, "result": result }).to_string().into(),
                    ))
                    .unwrap();
            }
            socket.close(None).unwrap();
        });

        let target = target(
            "app://-/index.html",
            &format!("ws://127.0.0.1:{port}/devtools/page/page-closed"),
        );
        let mut session =
            TargetSession::connect_and_install(&target, port, "window.test = true;", "test-token")
                .expect("the simulated target should accept installation");
        server.join().unwrap();
        assert!(session.pump_events().is_err());
        session.close();
    }
}
