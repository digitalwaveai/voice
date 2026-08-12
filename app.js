const MAX_PARTICIPANTS = 8;
const ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  // Если позже понадобится TURN, добавь сюда объект:
  // { urls: "turns:your-turn-server:443", username: "user", credential: "password" }
];

const state = {
  mode: "create",
  view: "lobby",
  roomId: "",
  name: "",
  clientId: sessionStorage.getItem("voicelink-client-id") || makeId(),
  socket: null,
  socketPromise: null,
  intentionalClose: false,
  localStream: null,
  muted: false,
  participants: [],
  peers: new Map(),
  pendingRequests: new Map(),
};

sessionStorage.setItem("voicelink-client-id", state.clientId);

const $ = (selector) => document.querySelector(selector);
const lobby = $("#lobby");
const call = $("#call");
const form = $("#join-form");
const createTab = $("#create-tab");
const joinTab = $("#join-tab");
const nameInput = $("#name-input");
const roomInput = $("#room-input");
const roomField = $("#room-field");
const cardIcon = $("#card-icon");
const cardTitle = $("#card-title");
const cardSubtitle = $("#card-subtitle");
const submitButton = $("#submit-button");
const submitIcon = $("#submit-icon");
const submitText = $("#submit-text");
const formError = $("#form-error");
const participantsElement = $("#participants");
const roomCodeElement = $("#room-code");
const roomCaption = $("#room-caption");
const connectionStatus = $("#connection-status");
const muteButton = $("#mute-button");
const micStatus = $("#mic-status");
const remoteAudio = $("#remote-audio");

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function setMode(mode) {
  state.mode = mode;
  const joining = mode === "join";
  createTab.classList.toggle("active", !joining);
  joinTab.classList.toggle("active", joining);
  roomField.classList.toggle("hidden", !joining);
  cardIcon.textContent = joining ? "↪" : "＋";
  cardTitle.textContent = joining ? "Войти к друзьям" : "Новая комната";
  cardSubtitle.textContent = joining ? "Введи ID, который прислал друг" : "Получишь ID сразу после создания";
  submitIcon.textContent = joining ? "↪" : "＋";
  submitText.textContent = joining ? "Подключиться" : "Создать комнату";
  hideError();
}

function showError(message) {
  formError.textContent = message;
  formError.classList.remove("hidden");
}

function hideError() {
  formError.textContent = "";
  formError.classList.add("hidden");
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.classList.toggle("loading", loading);
  submitText.textContent = loading
    ? "Подключаем…"
    : state.mode === "create" ? "Создать комнату" : "Подключиться";
  if (!loading) submitIcon.textContent = state.mode === "create" ? "＋" : "↪";
}

function wsUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

function connectSocket() {
  if (state.socket?.readyState === WebSocket.OPEN) return Promise.resolve(state.socket);
  if (state.socketPromise) return state.socketPromise;

  state.intentionalClose = false;
  state.socketPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl());
    state.socket = socket;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Сервер связи не отвечает"));
    }, 5000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      updateConnection(true);
      resolve(socket);
      if (state.view === "call" && state.roomId) {
        request("join", { roomId: state.roomId, name: state.name, clientId: state.clientId }).catch(() => leaveRoom());
      }
    }, { once: true });

    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      updateConnection(false);
      reject(new Error("Не удалось подключиться к серверу"));
    }, { once: true });

    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      updateConnection(false);
      rejectPending("Соединение с сервером потеряно");
      if (!state.intentionalClose && state.view === "call") setTimeout(() => connectSocket().catch(() => {}), 350);
    });
  });

  return state.socketPromise;
}

function send(type, data = {}) {
  if (state.socket?.readyState !== WebSocket.OPEN) throw new Error("Нет соединения с сервером");
  state.socket.send(JSON.stringify({ type, ...data }));
}

function request(type, data = {}) {
  const requestId = makeId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      reject(new Error("Сервер не ответил вовремя"));
    }, 5000);
    state.pendingRequests.set(requestId, { resolve, reject, timeout });
    send(type, { ...data, requestId });
  });
}

function rejectPending(message) {
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  state.pendingRequests.clear();
}

async function handleSocketMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  if (message.type === "ack") {
    const pending = state.pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    state.pendingRequests.delete(message.requestId);
    message.ok ? pending.resolve(message) : pending.reject(new Error(message.error || "Ошибка сервера"));
    return;
  }

  if (message.type === "room-state") {
    state.participants = message.participants || [];
    syncPeers();
    renderParticipants();
    return;
  }

  if (message.type === "signal") {
    try { await handleSignal(message); } catch { closePeer(message.senderId); }
  }
}

function updateConnection(connected) {
  connectionStatus.classList.toggle("reconnecting", !connected);
  connectionStatus.innerHTML = `<span class="live-dot"></span>${connected ? "Защищённая связь" : "Переподключение"}`;
}

function createPeer(peerId, peerName) {
  const current = state.peers.get(peerId);
  if (current && !["closed", "failed"].includes(current.pc.connectionState)) return current;
  if (current) closePeer(peerId);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });
  const peer = { pc, name: peerName, pendingCandidates: [], audio: null };
  state.peers.set(peerId, peer);

  state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) send("signal", { recipientId: peerId, signalType: "ice", payload: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    if (!peer.audio) {
      peer.audio = document.createElement("audio");
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      remoteAudio.append(peer.audio);
    }
    peer.audio.srcObject = event.streams[0];
    peer.audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(peerId);
    renderParticipants();
  };

  return peer;
}

async function startOffer(peerId, peerName) {
  const peer = createPeer(peerId, peerName);
  if (peer.pc.signalingState !== "stable") return;
  const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
  await peer.pc.setLocalDescription(offer);
  send("signal", { recipientId: peerId, signalType: "offer", payload: offer });
}

async function handleSignal(message) {
  if (message.senderId === state.clientId) return;
  if (message.signalType === "leave") {
    closePeer(message.senderId);
    return;
  }

  const peer = createPeer(message.senderId, message.senderName);
  if (message.signalType === "offer") {
    await peer.pc.setRemoteDescription(message.payload);
    for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    send("signal", { recipientId: message.senderId, signalType: "answer", payload: answer });
  } else if (message.signalType === "answer") {
    await peer.pc.setRemoteDescription(message.payload);
    for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  } else if (message.signalType === "ice") {
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.payload);
    else peer.pendingCandidates.push(message.payload);
  }
}

function syncPeers() {
  const activeIds = new Set(state.participants.map((person) => person.id));
  for (const peerId of state.peers.keys()) if (!activeIds.has(peerId)) closePeer(peerId);

  for (const person of state.participants) {
    if (person.id === state.clientId || state.peers.has(person.id)) continue;
    if (state.clientId.localeCompare(person.id) < 0) startOffer(person.id, person.name).catch(() => closePeer(person.id));
  }
}

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.close();
  peer.audio?.remove();
  state.peers.delete(peerId);
}

function closeAllPeers() {
  for (const peerId of [...state.peers.keys()]) closePeer(peerId);
}

function participantCard(person, isSelf) {
  const peer = state.peers.get(person.id);
  const connected = isSelf || peer?.pc.connectionState === "connected";
  const card = document.createElement("article");
  card.className = `participant-card ${connected ? "connected" : ""}`;

  const top = document.createElement("div");
  top.className = "participant-state";
  const dot = document.createElement("span");
  dot.className = "state-dot";
  const status = document.createElement("span");
  status.textContent = connected ? "На связи" : "Подключение";
  top.append(dot, status);

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(person.name);

  const personName = document.createElement("h3");
  personName.className = "participant-name";
  personName.textContent = person.name;

  const role = document.createElement("span");
  role.className = "participant-role";
  role.textContent = isSelf ? "Это ты" : "Слушает";

  const mic = document.createElement("span");
  mic.className = `mic-badge ${isSelf && state.muted ? "muted" : ""}`;
  mic.textContent = isSelf && state.muted ? "×" : "♩";
  card.append(top, avatar, personName, role, mic);
  return card;
}

function renderParticipants() {
  participantsElement.replaceChildren();
  const self = { id: state.clientId, name: state.name };
  const people = [self, ...state.participants.filter((person) => person.id !== state.clientId)];

  for (const person of people) participantsElement.append(participantCard(person, person.id === state.clientId));

  if (people.length < MAX_PARTICIPANTS) {
    const invite = document.createElement("button");
    invite.type = "button";
    invite.className = "invite-card";
    invite.innerHTML = '<span class="invite-plus">＋</span><strong>Позвать друга</strong><span>Скопировать приглашение</span>';
    invite.addEventListener("click", copyInvite);
    participantsElement.append(invite);
  }

  roomCaption.textContent = people.length === 1
    ? "Ждём остальных — отправь им приглашение"
    : `В комнате участников: ${people.length}`;
}

async function enterRoom(event) {
  event.preventDefault();
  hideError();
  setLoading(true);

  const name = nameInput.value.trim().replace(/\s+/g, " ").slice(0, 24);
  const roomId = roomInput.value.trim().toUpperCase();
  let stream = null;

  try {
    if (!name) throw new Error("Напиши своё имя");
    if (state.mode === "join" && roomId.length !== 6) throw new Error("ID комнаты состоит из 6 символов");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Браузер не поддерживает микрофон");

    const [micResult, socketResult] = await Promise.allSettled([
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }),
      connectSocket(),
    ]);

    if (micResult.status === "fulfilled") stream = micResult.value;
    if (socketResult.status === "rejected") throw socketResult.reason;
    if (!stream) throw micResult.status === "rejected" ? micResult.reason : new Error("Микрофон недоступен");

    state.localStream = stream;
    state.name = name;
    const response = await request(state.mode, {
      name,
      roomId: state.mode === "join" ? roomId : undefined,
      clientId: state.clientId,
    });

    state.roomId = response.roomId;
    state.participants = response.participants || [];
    state.view = "call";
    localStorage.setItem("voicelink-name", name);
    history.replaceState({}, "", `?room=${state.roomId}`);
    roomCodeElement.textContent = state.roomId;
    lobby.classList.add("hidden");
    call.classList.remove("hidden");
    renderParticipants();
    syncPeers();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    const message = error?.name === "NotAllowedError" ? "Разреши доступ к микрофону в браузере" : error.message || "Не удалось подключиться";
    showError(message);
  } finally {
    setLoading(false);
  }
}

function leaveRoom() {
  // Интерфейс закрывается сразу — сеть не задерживает выход.
  try { if (state.socket?.readyState === WebSocket.OPEN) send("leave"); } catch {}
  closeAllPeers();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  state.participants = [];
  state.roomId = "";
  state.view = "lobby";
  state.muted = false;
  muteButton.classList.remove("muted");
  muteButton.textContent = "♩";
  micStatus.textContent = "Микрофон включён";
  remoteAudio.replaceChildren();
  call.classList.add("hidden");
  lobby.classList.remove("hidden");
  history.replaceState({}, "", location.pathname);
}

function toggleMute() {
  state.muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((track) => { track.enabled = !state.muted; });
  muteButton.classList.toggle("muted", state.muted);
  muteButton.textContent = state.muted ? "×" : "♩";
  muteButton.setAttribute("aria-label", state.muted ? "Включить микрофон" : "Выключить микрофон");
  micStatus.textContent = state.muted ? "Микрофон выключен" : "Микрофон включён";
  renderParticipants();
}

async function copyInvite() {
  const link = `${location.origin}${location.pathname}?room=${state.roomId}`;
  try {
    await navigator.clipboard.writeText(link);
    $("#copy-icon").textContent = "✓";
    setTimeout(() => { $("#copy-icon").textContent = "▣"; }, 1500);
  } catch {
    window.prompt("Скопируй ссылку:", link);
  }
}

createTab.addEventListener("click", () => setMode("create"));
joinTab.addEventListener("click", () => setMode("join"));
form.addEventListener("submit", enterRoom);
roomInput.addEventListener("input", () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });
$("#copy-room").addEventListener("click", copyInvite);
$("#hangup-button").addEventListener("click", leaveRoom);
$("#logo-exit").addEventListener("click", leaveRoom);
muteButton.addEventListener("click", toggleMute);

window.addEventListener("beforeunload", () => {
  state.intentionalClose = true;
  try { if (state.socket?.readyState === WebSocket.OPEN) send("leave"); } catch {}
});

const invitedRoom = new URLSearchParams(location.search).get("room")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
nameInput.value = localStorage.getItem("voicelink-name") || "";
if (invitedRoom) {
  roomInput.value = invitedRoom;
  setMode("join");
}

// Открываем соединение заранее, чтобы создание комнаты было быстрее.
connectSocket().catch(() => {});
