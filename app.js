(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = "top1_session_v1";
  const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const ANSWER_DURATION_MS = 45_000;

  const state = {
    auth: null,
    db: null,
    uid: null,
    roomCode: null,
    meta: null,
    config: null,
    players: {},
    roundPublic: {},
    history: {},
    privateChoiceId: null,
    myChoiceText: "",
    submissionStatus: {},
    voteStatus: {},
    publicChoices: {},
    votes: {},
    roundResult: null,
    hostPrivateChoices: {},
    listeners: [],
    roundListeners: [],
    hostListeners: [],
    onDisconnectRef: null,
    hostBusy: false,
    actionBusy: false,
    activeRoundId: null,
    activeRoundKey: null,
    hostWatchdog: null,
    answerTimerInterval: null,
    serverTimeOffset: 0
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showScreen(id) {
    ["loadingScreen", "setupScreen", "homeScreen", "roomScreen"].forEach((screenId) => {
      $(screenId).classList.toggle("hidden", screenId !== id);
    });
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`.trim();
    node.textContent = message;
    $("toastRegion").appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.originalText;
  }

  function validFirebaseConfig(config) {
    if (!config || typeof config !== "object") return false;
    const required = ["apiKey", "authDomain", "databaseURL", "projectId"];
    return required.every((key) => {
      const value = String(config[key] || "");
      return value && !value.includes("COLE_");
    });
  }

  function normalizeText(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function normalizedAnswerKey(text) {
    return normalizeText(String(text || "").replace(/\s+/g, " "))
      .toLocaleLowerCase("pt-BR")
      .trim();
  }

  function hash32(text, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function choiceIdForAnswer(roundId, answer) {
    const key = `${roundId}|${normalizedAnswerKey(answer)}`;
    const a = hash32(key, 2166136261).toString(16).padStart(8, "0");
    const b = hash32(key, 3335557771).toString(16).padStart(8, "0");
    return `${a}${b}`;
  }

  function deterministicChoiceOrder(choiceId) {
    return parseInt(String(choiceId).slice(0, 8), 16) || 0;
  }

  function serverNow() {
    return Date.now() + Number(state.serverTimeOffset || 0);
  }

  function answerDeadlineAt() {
    const createdAt = Number(state.roundPublic?.createdAt || 0);
    return createdAt > 0 ? createdAt + ANSWER_DURATION_MS : 0;
  }

  function answerRemainingMs() {
    const deadline = answerDeadlineAt();
    return deadline ? Math.max(0, deadline - serverNow()) : ANSWER_DURATION_MS;
  }

  function updateAnswerTimerUI() {
    const timer = $("answerTimer");
    if (!timer) return;
    const remaining = answerRemainingMs();
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    timer.textContent = `${seconds}s`;
    timer.classList.toggle("urgent", seconds <= 10);

    const input = $("answerInput");
    const button = $("submitAnswerBtn");
    if (remaining <= 0) {
      if (input) input.disabled = true;
      if (button) button.disabled = true;
      if (isHost()) queueHostProgress();
    }
  }

  function syncAnswerTimer() {
    if (state.answerTimerInterval) clearInterval(state.answerTimerInterval);
    state.answerTimerInterval = null;
    if (state.meta?.phase !== "answering" || !Number(state.roundPublic?.createdAt || 0)) return;
    updateAnswerTimerUI();
    state.answerTimerInterval = setInterval(updateAnswerTimerUI, 250);
  }

  function normalizeName(name) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, 20);
  }

  function validName(name) {
    const n = normalizeName(name);
    return n.length >= 2 && n.length <= 20;
  }

  function normalizeRoomCode(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  }

  function randomString(length = 6) {
    let out = "";
    if (window.crypto?.getRandomValues) {
      const values = new Uint32Array(length);
      window.crypto.getRandomValues(values);
      for (let i = 0; i < length; i++) out += ROOM_CHARS[values[i] % ROOM_CHARS.length];
      return out;
    }
    for (let i = 0; i < length; i++) out += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    return out;
  }

  function serverTimestamp() {
    return firebase.database.ServerValue.TIMESTAMP;
  }

  function roomRef(path = "") {
    if (!state.roomCode) throw new Error("Sala não selecionada.");
    return state.db.ref(`rooms/${state.roomCode}${path ? `/${path}` : ""}`);
  }

  function isHost() {
    return !!state.meta && state.meta.hostUid === state.uid;
  }

  function myPlayer() {
    return state.players?.[state.uid] || null;
  }

  function connectedPlayers() {
    return Object.entries(state.players || {})
      .filter(([, p]) => p?.connected)
      .map(([uid, p]) => ({ uid, ...p }));
  }

  function selectedCategoryIds() {
    return Object.entries(state.config?.selectedCategories || {})
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id);
  }

  function categoryLabel(id) {
    return GAME_DATA.categories.find((c) => c.id === id)?.label || id;
  }

  function saveSession(name) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.roomCode, name: normalizeName(name), uid: state.uid }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }

  async function init() {
    bindStaticEvents();

    if (!validFirebaseConfig(window.FIREBASE_CONFIG)) {
      $("setupReason").textContent = "O link do Firebase Console não revela a apiKey do app Web, então ela precisa ser colada uma única vez no arquivo de configuração.";
      showScreen("setupScreen");
      return;
    }

    try {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      state.auth = firebase.auth();
      state.db = firebase.database();
      state.db.ref(".info/serverTimeOffset").on("value", (snap) => {
        state.serverTimeOffset = Number(snap.val() || 0);
        updateAnswerTimerUI();
      });
      await state.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

      state.auth.onAuthStateChanged(async (user) => {
        try {
          if (!user) {
            await state.auth.signInAnonymously();
            return;
          }
          state.uid = user.uid;
          await tryRestoreSession();
        } catch (err) {
          console.error(err);
          toast(humanizeFirebaseError(err), "error");
          showScreen("homeScreen");
        }
      });
    } catch (err) {
      console.error(err);
      $("setupReason").textContent = `Falha ao iniciar Firebase: ${humanizeFirebaseError(err)}`;
      showScreen("setupScreen");
    }
  }

  function bindStaticEvents() {
    $("roomCodeInput").addEventListener("input", (e) => {
      e.target.value = normalizeRoomCode(e.target.value);
    });
    $("createRoomBtn").addEventListener("click", createRoom);
    $("joinRoomBtn").addEventListener("click", joinRoom);
    $("roomCodeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
    $("joinName").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
    $("createName").addEventListener("keydown", (e) => { if (e.key === "Enter") createRoom(); });
    $("brandBtn").addEventListener("click", () => {
      if (!state.roomCode) showScreen("homeScreen");
    });
  }

  async function tryRestoreSession() {
    const session = getSession();
    if (!session?.roomCode || session.uid !== state.uid) {
      clearSession();
      showScreen("homeScreen");
      return;
    }

    const code = normalizeRoomCode(session.roomCode);
    const playerSnap = await state.db.ref(`rooms/${code}/players/${state.uid}`).once("value");
    if (!playerSnap.exists()) {
      clearSession();
      showScreen("homeScreen");
      return;
    }

    state.roomCode = code;
    await state.db.ref(`rooms/${code}/players/${state.uid}/connected`).set(true);
    await enterRoom(code, session.name || playerSnap.val()?.name || "Jogador");
  }

  async function generateUniqueRoomCode() {
    for (let i = 0; i < 12; i++) {
      const code = randomString(6);
      const snap = await state.db.ref(`rooms/${code}/meta`).once("value");
      if (!snap.exists()) return code;
    }
    throw new Error("Não foi possível gerar um código de sala. Tente novamente.");
  }

  async function createRoom() {
    if (state.actionBusy) return;
    const button = $("createRoomBtn");
    const name = normalizeName($("createName").value);
    if (!validName(name)) return toast("Use um nome entre 2 e 20 caracteres.", "error");

    state.actionBusy = true;
    setBusy(button, true, "Criando...");
    try {
      const code = await generateUniqueRoomCode();
      const room = {
        meta: {
          hostUid: state.uid,
          phase: "lobby",
          roundNumber: 0,
          currentRoundId: "",
          createdAt: serverTimestamp(),
          winnerUid: "",
          suddenDeath: false,
          lastActionAt: serverTimestamp()
        },
        config: {
          targetScore: 10,
          minPlayers: 3,
          maxPlayers: 10,
          selectedCategories: { geral: true }
        },
        players: {
          [state.uid]: { name, connected: true, joinedAt: serverTimestamp(), score: 0, slot: "0" }
        },
        slots: {
          "0": state.uid
        }
      };

      await state.db.ref(`rooms/${code}`).set(room);
      state.roomCode = code;
      saveSession(name);
      await enterRoom(code, name);
      toast("Sala criada.", "success");
    } catch (err) {
      console.error(err);
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function claimRoomSlot(code, maxPlayers) {
    const slots = Array.from({ length: maxPlayers }, (_, i) => String(i));
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    for (const slot of slots) {
      const ref = state.db.ref(`rooms/${code}/slots/${slot}`);
      try {
        const tx = await ref.transaction((current) => {
          if (current === null || current === state.uid) return state.uid;
          return;
        });
        if (tx.committed && tx.snapshot.val() === state.uid) {
          await ref.onDisconnect().remove();
          return { slot, ref };
        }
      } catch (err) {
        if (String(err?.code || "").includes("permission-denied")) throw err;
      }
    }
    return null;
  }

  async function joinRoom() {
    if (state.actionBusy) return;
    const button = $("joinRoomBtn");
    const name = normalizeName($("joinName").value);
    const code = normalizeRoomCode($("roomCodeInput").value);
    if (!validName(name)) return toast("Use um nome entre 2 e 20 caracteres.", "error");
    if (code.length !== 6) return toast("Digite um código de sala com 6 caracteres.", "error");

    state.actionBusy = true;
    setBusy(button, true, "Entrando...");
    try {
      const [metaSnap, configSnap, existingSnap] = await Promise.all([
        state.db.ref(`rooms/${code}/meta`).once("value"),
        state.db.ref(`rooms/${code}/config`).once("value"),
        state.db.ref(`rooms/${code}/players/${state.uid}`).once("value")
      ]);

      if (!metaSnap.exists()) throw new Error("Sala inexistente ou encerrada.");
      const meta = metaSnap.val();
      const config = configSnap.val();

      if (existingSnap.exists()) {
        state.roomCode = code;
        await state.db.ref(`rooms/${code}/players/${state.uid}/connected`).set(true);
        saveSession(existingSnap.val()?.name || name);
        await enterRoom(code, existingSnap.val()?.name || name);
        return;
      }

      if (meta.phase !== "lobby") throw new Error("A partida já está em andamento.");

      const maxPlayers = Math.max(3, Math.min(10, Number(config?.maxPlayers || 10)));
      const claimed = await claimRoomSlot(code, maxPlayers);
      if (!claimed) throw new Error("A sala está cheia.");

      try {
        await state.db.ref(`rooms/${code}/players/${state.uid}`).set({
          name,
          connected: true,
          joinedAt: serverTimestamp(),
          score: 0,
          slot: claimed.slot
        });
        await claimed.ref.onDisconnect().cancel();
      } catch (playerErr) {
        console.error("Falha após reservar vaga:", playerErr);
        try { await claimed.ref.onDisconnect().cancel(); } catch {}
        try { await claimed.ref.remove(); } catch {}
        throw playerErr;
      }

      state.roomCode = code;
      saveSession(name);
      await enterRoom(code, name);
      toast("Você entrou na sala.", "success");
    } catch (err) {
      console.error(err);
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function enterRoom(code, name) {
    detachAllListeners();
    state.roomCode = code;
    state.meta = null;
    state.config = null;
    state.players = {};
    state.history = {};
    state.roundPublic = {};
    state.activeRoundId = null;
    state.activeRoundKey = null;

    const connectedRef = state.db.ref(`rooms/${code}/players/${state.uid}/connected`);
    state.onDisconnectRef = connectedRef;
    await connectedRef.onDisconnect().set(false);
    await connectedRef.set(true);
    saveSession(name);

    $("roomBadge").textContent = code;
    $("roomBadge").classList.remove("hidden");
    showScreen("roomScreen");

    if (state.hostWatchdog) clearInterval(state.hostWatchdog);
    state.hostWatchdog = setInterval(() => {
      if (isHost() && ["answering", "voting", "scoring"].includes(state.meta?.phase)) queueHostProgress();
    }, 3000);

    addListener(state.db.ref(`rooms/${code}/meta`), "value", (snap) => {
      if (!snap.exists()) {
        handleRoomClosed();
        return;
      }
      state.meta = snap.val();
      attachRoundListenersIfNeeded();
      attachHostListenersIfNeeded();
      renderRoom();
      ensureHostIfNeeded();
      queueHostProgress();
    });

    addListener(state.db.ref(`rooms/${code}/config`), "value", (snap) => {
      state.config = snap.val() || null;
      renderRoom();
    });

    addListener(state.db.ref(`rooms/${code}/players`), "value", (snap) => {
      state.players = snap.val() || {};
      if (!state.players[state.uid]) {
        toast("Você não está mais nesta sala.", "error");
        leaveLocalRoom();
        return;
      }
      renderRoom();
      ensureHostIfNeeded();
      queueHostProgress();
    });

    addListener(state.db.ref(`rooms/${code}/history`), "value", (snap) => {
      state.history = snap.val() || {};
    });
  }

  function addListener(ref, event, callback, bucket = state.listeners) {
    ref.on(event, callback);
    bucket.push(() => ref.off(event, callback));
  }

  function detachBucket(bucket) {
    bucket.splice(0).forEach((off) => {
      try { off(); } catch (err) { console.warn(err); }
    });
  }

  function detachAllListeners() {
    detachBucket(state.roundListeners);
    detachBucket(state.hostListeners);
    detachBucket(state.listeners);
  }

  function attachRoundListenersIfNeeded() {
    const roundId = state.meta?.currentRoundId || "";
    const phase = state.meta?.phase || "";
    const key = `${roundId}:${phase}`;
    if (key === state.activeRoundKey) return;

    detachBucket(state.roundListeners);
    state.activeRoundId = roundId;
    state.activeRoundKey = key;
    state.privateChoiceId = null;
    state.myChoiceText = "";
    state.submissionStatus = {};
    state.voteStatus = {};
    state.publicChoices = {};
    state.votes = {};
    state.roundResult = null;

    if (!roundId) return;

    addListener(roomRef(`roundPublic/${roundId}`), "value", (snap) => {
      state.roundPublic = snap.val() || {};
      renderRoom();
    }, state.roundListeners);

    addListener(roomRef(`privateChoices/${roundId}/${state.uid}`), "value", async (snap) => {
      state.privateChoiceId = snap.val() || null;
      if (state.privateChoiceId && phase === "answering") {
        try {
          const ownChoice = await roomRef(`publicChoices/${roundId}/${state.privateChoiceId}`).once("value");
          state.myChoiceText = ownChoice.val()?.text || "";
          if (ownChoice.exists()) {
            roomRef(`submissionStatus/${roundId}/${state.uid}`).set(true).catch(() => {});
          }
        } catch {
          state.myChoiceText = "";
        }
      }
      renderRoom();
    }, state.roundListeners);

    addListener(roomRef(`submissionStatus/${roundId}/${state.uid}`), "value", (snap) => {
      if (snap.val() === true) state.submissionStatus = { [state.uid]: true };
      else state.submissionStatus = {};
      renderRoom();
    }, state.roundListeners);

    if (["voting", "scoring", "result", "finished"].includes(phase)) {
      addListener(roomRef(`publicChoices/${roundId}`), "value", (snap) => {
        state.publicChoices = snap.val() || {};
        renderRoom();
      }, state.roundListeners);

      addListener(roomRef(`votes/${roundId}/${state.uid}`), "value", (snap) => {
        const myVote = snap.val();
        if (myVote) {
          state.votes = { ...state.votes, [state.uid]: myVote };
          if (phase === "voting") roomRef(`voteStatus/${roundId}/${state.uid}`).set(true).catch(() => {});
        } else {
          const copy = { ...state.votes };
          delete copy[state.uid];
          state.votes = copy;
        }
        renderRoom();
      }, state.roundListeners);
    }

    if (["result", "finished"].includes(phase)) {
      addListener(roomRef(`roundResult/${roundId}`), "value", (snap) => {
        state.roundResult = snap.val() || null;
        renderRoom();
      }, state.roundListeners);
    }
  }

  function attachHostListenersIfNeeded() {
    detachBucket(state.hostListeners);
    state.hostPrivateChoices = {};

    if (!isHost() || !state.meta?.currentRoundId) return;
    const roundId = state.meta.currentRoundId;
    const phase = state.meta.phase;

    if (["answering", "voting", "scoring"].includes(phase)) {
      addListener(roomRef(`submissionStatus/${roundId}`), "value", (snap) => {
        state.submissionStatus = snap.val() || {};
        queueHostProgress();
      }, state.hostListeners);
    }

    if (["voting", "scoring"].includes(phase)) {
      addListener(roomRef(`voteStatus/${roundId}`), "value", (snap) => {
        state.voteStatus = snap.val() || {};
        queueHostProgress();
      }, state.hostListeners);
    }

    if (phase === "scoring") {
      addListener(roomRef(`votes/${roundId}`), "value", (snap) => {
        state.votes = snap.val() || {};
        queueHostProgress();
      }, state.hostListeners);

      addListener(roomRef(`privateChoices/${roundId}`), "value", (snap) => {
        state.hostPrivateChoices = snap.val() || {};
        queueHostProgress();
      }, state.hostListeners);
    }
  }

  async function ensureHostIfNeeded() {
    if (!state.meta || !state.players?.[state.uid]) return;
    const hostUid = state.meta.hostUid;
    if (!hostUid || hostUid === state.uid) return;
    const host = state.players[hostUid];
    if (host?.connected !== false) return;

    try {
      await roomRef("meta/hostUid").transaction((current) => {
        if (current !== hostUid) return;
        return state.uid;
      });
    } catch (err) {
      console.warn("Não foi possível assumir host:", err);
    }
  }

  function queueHostProgress() {
    if (!isHost() || state.hostBusy) return;
    clearTimeout(queueHostProgress.timer);
    queueHostProgress.timer = setTimeout(maybeHostProgress, 120);
  }

  async function maybeHostProgress() {
    if (state.hostBusy || !state.roomCode) return;

    try {
      state.hostBusy = true;
      const metaSnap = await roomRef("meta").once("value");
      const meta = metaSnap.val();
      if (!meta || meta.hostUid !== state.uid || !meta.currentRoundId) return;

      const phase = meta.phase;
      const roundId = meta.currentRoundId;

      if (phase === "answering") {
        const [playersSnap, statusSnap, roundSnap] = await Promise.all([
          roomRef("players").once("value"),
          roomRef(`submissionStatus/${roundId}`).once("value"),
          roomRef(`roundPublic/${roundId}`).once("value")
        ]);
        const players = playersSnap.val() || {};
        const status = statusSnap.val() || {};
        const round = roundSnap.val() || {};
        const active = Object.entries(players)
          .filter(([, player]) => player?.connected)
          .map(([uid, player]) => ({ uid, ...player }));
        const submittedCount = Object.values(status).filter((value) => value === true).length;
        const allConnectedAnswered = active.length > 0 && active.every((player) => status[player.uid] === true);
        const deadline = Number(round.createdAt || 0) + ANSWER_DURATION_MS;
        const timedOut = Number(round.createdAt || 0) > 0 && serverNow() >= deadline;

        if ((allConnectedAnswered || timedOut) && submittedCount >= 2) {
          await beginVoting(roundId);
        } else if (timedOut) {
          await roomRef().update({
            "meta/phase": "scoring",
            "meta/lastActionAt": serverTimestamp()
          });
        }
        return;
      }

      if (phase === "voting") {
        const [playersSnap, statusSnap, voteStatusSnap, choicesSnap] = await Promise.all([
          roomRef("players").once("value"),
          roomRef(`submissionStatus/${roundId}`).once("value"),
          roomRef(`voteStatus/${roundId}`).once("value"),
          roomRef(`publicChoices/${roundId}`).once("value")
        ]);
        const players = playersSnap.val() || {};
        const status = statusSnap.val() || {};
        const voteStatus = voteStatusSnap.val() || {};
        const choices = choicesSnap.val() || {};
        const participating = Object.entries(players)
          .filter(([, player]) => player?.connected)
          .map(([uid]) => uid)
          .filter((uid) => status[uid] === true);
        const choiceCount = Object.keys(choices).length;
        const allVoted = participating.every((uid) => voteStatus[uid] === true);
        if (choiceCount < 2 || allVoted) {
          await roomRef().update({
            "meta/phase": "scoring",
            "meta/lastActionAt": serverTimestamp()
          });
        }
        return;
      }

      if (phase === "scoring") {
        const [statusSnap, voteStatusSnap, votesSnap, privateSnap, choicesSnap, playersSnap, configSnap] = await Promise.all([
          roomRef(`submissionStatus/${roundId}`).once("value"),
          roomRef(`voteStatus/${roundId}`).once("value"),
          roomRef(`votes/${roundId}`).once("value"),
          roomRef(`privateChoices/${roundId}`).once("value"),
          roomRef(`publicChoices/${roundId}`).once("value"),
          roomRef("players").once("value"),
          roomRef("config").once("value")
        ]);

        state.submissionStatus = statusSnap.val() || {};
        state.voteStatus = voteStatusSnap.val() || {};
        state.votes = votesSnap.val() || {};
        state.hostPrivateChoices = privateSnap.val() || {};
        state.publicChoices = choicesSnap.val() || {};
        state.players = playersSnap.val() || state.players;
        state.config = configSnap.val() || state.config;

        const submittedUids = Object.keys(state.submissionStatus).filter((uid) => state.submissionStatus[uid] === true);
        const votedUids = Object.keys(state.voteStatus).filter((uid) => state.voteStatus[uid] === true);
        const mappingsReady = submittedUids.length > 0 && submittedUids.every((uid) => !!state.hostPrivateChoices[uid]);
        const votesReady = votedUids.every((uid) => !!state.votes[uid]);
        if (mappingsReady && votesReady) await finishRound(roundId);
      }
    } catch (err) {
      console.error("Host progress error:", err);
    } finally {
      state.hostBusy = false;
    }
  }

  async function beginVoting(roundId) {
    const phaseSnap = await roomRef("meta/phase").once("value");
    if (phaseSnap.val() !== "answering") return;
    await roomRef().update({
      "meta/phase": "voting",
      "meta/lastActionAt": serverTimestamp()
    });
  }

  async function finishRound(roundId) {
    const phaseSnap = await roomRef("meta/phase").once("value");
    if (phaseSnap.val() !== "scoring") return;

    const choiceEntries = Object.entries(state.publicChoices || {});
    if (!choiceEntries.length) {
      await roomRef().update({
        [`roundResult/${roundId}`]: {
          roundId,
          cancelled: true,
          ranking: [],
          createdAt: serverTimestamp()
        },
        "meta/phase": "result",
        "meta/lastActionAt": serverTimestamp()
      });
      return;
    }

    const tally = {};
    choiceEntries.forEach(([choiceId]) => { tally[choiceId] = 0; });
    Object.values(state.votes || {}).forEach((vote) => {
      if (vote?.choiceId && Object.prototype.hasOwnProperty.call(tally, vote.choiceId)) tally[vote.choiceId] += 1;
    });

    const maxVotes = Math.max(0, ...Object.values(tally));
    const winningChoices = maxVotes > 0 ? Object.keys(tally).filter((choiceId) => tally[choiceId] === maxVotes) : [];
    const pointsPerWinner = winningChoices.length === 1 ? 2 : (winningChoices.length > 1 ? 1 : 0);

    const scoreMap = {};
    Object.entries(state.players || {}).forEach(([uid, player]) => { scoreMap[uid] = Number(player.score || 0); });

    const awardsByUid = {};
    const ownersByChoice = {};
    Object.entries(state.hostPrivateChoices || {}).forEach(([uid, choiceId]) => {
      if (!choiceId || state.submissionStatus?.[uid] !== true) return;
      if (!ownersByChoice[choiceId]) ownersByChoice[choiceId] = [];
      ownersByChoice[choiceId].push(uid);
    });

    winningChoices.forEach((choiceId) => {
      const ownerUids = ownersByChoice[choiceId] || [];
      ownerUids.forEach((ownerUid) => {
        if (!Object.prototype.hasOwnProperty.call(scoreMap, ownerUid)) return;
        scoreMap[ownerUid] += pointsPerWinner;
        awardsByUid[ownerUid] = (awardsByUid[ownerUid] || 0) + pointsPerWinner;
      });
    });

    const ranking = choiceEntries
      .map(([choiceId, choice]) => {
        const ownerUids = ownersByChoice[choiceId] || [];
        const ownerNames = ownerUids.map((uid) => state.players?.[uid]?.name || "Jogador");
        return {
          choiceId,
          text: choice.text,
          ownerUids,
          ownerNames,
          ownerCount: ownerUids.length,
          votes: tally[choiceId] || 0,
          points: winningChoices.includes(choiceId) ? pointsPerWinner : 0,
          order: Number(choice.order || 0)
        };
      })
      .sort((a, b) => (b.votes - a.votes) || (a.order - b.order));

    const target = Number(state.config?.targetScore || 10);
    const scoresSorted = Object.entries(scoreMap).sort((a, b) => b[1] - a[1]);
    const topScore = scoresSorted[0]?.[1] || 0;
    const topUids = scoresSorted.filter(([, score]) => score === topScore).map(([uid]) => uid);
    const hasReachedTarget = topScore >= target;
    const hasSingleChampion = hasReachedTarget && topUids.length === 1;
    const suddenDeath = hasReachedTarget && topUids.length > 1;
    const winnerUid = hasSingleChampion ? topUids[0] : "";

    const updates = {};
    Object.entries(scoreMap).forEach(([uid, score]) => { updates[`players/${uid}/score`] = score; });
    updates[`roundResult/${roundId}`] = {
      roundId,
      maxVotes,
      pointsPerWinner,
      ranking,
      createdAt: serverTimestamp()
    };
    updates["meta/phase"] = hasSingleChampion ? "finished" : "result";
    updates["meta/winnerUid"] = winnerUid;
    updates["meta/suddenDeath"] = suddenDeath;
    updates["meta/lastActionAt"] = serverTimestamp();

    await roomRef().update(updates);
  }

  function renderRoom() {
    if (!state.roomCode || !state.players?.[state.uid]) return;
    const phase = state.meta?.phase || "lobby";
    let content = "";
    if (phase === "lobby") content = renderLobby();
    else if (phase === "answering") content = renderAnswering();
    else if (phase === "voting") content = renderVoting();
    else if (phase === "scoring") content = renderScoring();
    else if (phase === "result") content = renderResult(false);
    else if (phase === "finished") content = renderResult(true);
    else content = `<div class="panel"><p class="muted">Sincronizando estado da sala...</p></div>`;

    $("roomContent").innerHTML = content;
    bindDynamicEvents();
    syncAnswerTimer();
  }

  function renderRoomShell(mainContent) {
    const players = Object.entries(state.players || {})
      .sort((a, b) => (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

    const playerRows = players.map(([uid, player]) => `
      <div class="player-row">
        <div class="player-main">
          <span class="player-dot ${player.connected ? "online" : ""}"></span>
          <div>
            <div class="player-name">${escapeHtml(player.name)} ${uid === state.meta?.hostUid ? '<span class="host-tag">HOST</span>' : ""}</div>
            <div class="player-meta">${player.connected ? "online" : "desconectado"}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:7px">
          ${isHost() && state.meta?.phase === "lobby" && !player.connected && uid !== state.meta?.hostUid ? `<button class="btn btn-danger btn-small" data-kick-uid="${escapeHtml(uid)}" type="button">Remover</button>` : ""}
          <div class="score">${Number(player.score || 0)}</div>
        </div>
      </div>
    `).join("");

    return `
      <div class="room-layout">
        <div class="room-main">${mainContent}</div>
        <aside class="panel side-panel">
          <div class="round-topline">
            <div>
              <p class="eyebrow">Placar</p>
              <h3 style="margin:5px 0 0">${players.length} jogadores</h3>
            </div>
            <span class="chip">até ${Number(state.config?.targetScore || 10)}</span>
          </div>
          <div class="player-list">${playerRows}</div>
          ${isHost() && ["answering", "voting", "scoring"].includes(state.meta?.phase) ? '<button id="cancelRoundBtn" class="btn btn-danger btn-block" type="button">Cancelar rodada</button>' : ''}
          ${state.meta?.phase !== "lobby" ? '<button id="leaveRoomBtn" class="btn btn-ghost btn-block" type="button">Sair da sala</button>' : ''}
        </aside>
      </div>`;
  }

  function renderLobby() {
    const host = isHost();
    const connected = connectedPlayers().length;
    const selected = new Set(selectedCategoryIds());
    const categories = GAME_DATA.categories.map((category) => `
      <div class="category-option">
        <input id="cat-${category.id}" type="checkbox" data-category="${category.id}" ${selected.has(category.id) ? "checked" : ""} ${host ? "" : "disabled"} />
        <label for="cat-${category.id}">${escapeHtml(category.label)}</label>
      </div>
    `).join("");

    const main = `
      <div class="room-heading">
        <div>
          <p class="eyebrow">Sala ${escapeHtml(state.roomCode)}</p>
          <h1>Prepare a partida</h1>
        </div>
        <button id="copyCodeBtn" class="btn btn-ghost btn-small" type="button">Copiar código</button>
      </div>

      <div class="lobby-grid">
        <div class="panel">
          <div class="settings-grid">
            <div>
              <p class="eyebrow">Pontuação</p>
              <h3 style="margin:7px 0 14px">Pontos para vencer</h3>
              <div class="stepper">
                <button id="scoreMinus" class="btn btn-secondary btn-small" ${host ? "" : "disabled"}>−</button>
                <div class="stepper-value">${Number(state.config?.targetScore || 10)}</div>
                <button id="scorePlus" class="btn btn-secondary btn-small" ${host ? "" : "disabled"}>+</button>
              </div>
            </div>
            <div>
              <p class="eyebrow">Temas</p>
              <h3 style="margin:7px 0 14px">Selecione o que pode aparecer</h3>
              <div class="category-grid">${categories}</div>
            </div>
          </div>
        </div>

        <div class="notice">
          <strong>Como pontua:</strong> vencedor isolado da votação recebe 2 pontos. Se houver empate em primeiro, cada empatado recebe 1 ponto. Se dois jogadores alcançarem a meta empatados, a partida entra em desempate até existir um líder isolado.
        </div>

        ${host ? `
          <button id="startGameBtn" class="btn btn-primary" type="button" ${connected < 3 ? "disabled" : ""}>
            ${connected < 3 ? `Aguardando jogadores (${connected}/3)` : "Iniciar partida"}
          </button>
        ` : `<div class="panel wait-state"><div class="wait-icon">…</div><strong>Aguardando o host iniciar</strong><p class="muted">As configurações aparecem para todos em tempo real.</p></div>`}

        <div class="action-row">
          ${host ? '<button id="closeRoomBtn" class="btn btn-danger" type="button">Encerrar sala</button>' : ''}
          <button id="leaveRoomBtn" class="btn btn-ghost" type="button">Sair desta sala</button>
        </div>
      </div>`;

    return renderRoomShell(main);
  }

  function renderRoundHeader() {
    const round = state.roundPublic || {};
    return `
      <div class="round-topline">
        <span class="round-number">RODADA ${Number(round.roundNumber || state.meta?.roundNumber || 0)}</span>
        ${state.meta?.suddenDeath ? '<span class="chip">DESEMPATE</span>' : `<span class="chip">${escapeHtml(categoryLabel(round.category))}</span>`}
      </div>
      <div class="question-grid">
        <div>
          <p class="question-category">${escapeHtml(categoryLabel(round.category || ""))}</p>
          <h1 class="question-title">${escapeHtml(round.prompt || "Preparando pergunta...")}</h1>
        </div>
        <div class="letter-box" aria-label="Letra ${escapeHtml(round.letter || "")}">${escapeHtml(round.letter || "?")}</div>
      </div>`;
  }

  function renderAnswering() {
    const submitted = state.submissionStatus?.[state.uid] === true;
    const round = state.roundPublic || {};
    const main = `
      <div class="panel round-card">
        ${renderRoundHeader()}
        <div class="answer-timer-bar">
          <span>Tempo para responder</span>
          <strong id="answerTimer">45s</strong>
        </div>
        ${submitted ? `
          <div class="wait-state">
            <div class="wait-icon">✓</div>
            <strong>Resposta enviada</strong>
            ${state.myChoiceText ? `<p class="muted">Sua resposta: <strong>${escapeHtml(state.myChoiceText)}</strong></p>` : '<p class="muted">Sua resposta foi registrada.</p>'}
            <p class="status-line">Aguardando os outros jogadores. Respostas iguais serão agrupadas em uma única opção na votação.</p>
          </div>
        ` : `
          <div class="answer-area">
            <label class="field-label" for="answerInput">Sua resposta deve começar com ${escapeHtml(round.letter || "a letra sorteada")}</label>
            <div class="answer-row">
              <input id="answerInput" class="input" maxlength="40" autocomplete="off" placeholder="Digite sua resposta" />
              <button id="submitAnswerBtn" class="btn btn-primary" type="button">Confirmar</button>
            </div>
            <p class="status-line">Você tem 45 segundos. Depois de confirmar, a resposta fica travada. Respostas iguais contam como uma única opção, mas todos os autores recebem os pontos se ela vencer.</p>
          </div>
        `}
      </div>`;
    return renderRoomShell(main);
  }

  function renderVoting() {
    const choices = Object.entries(state.publicChoices || {}).sort((a, b) => Number(a[1].order || 0) - Number(b[1].order || 0));
    const myVote = state.votes?.[state.uid]?.choiceId || null;
    const myChoice = state.privateChoiceId;
    const participated = state.submissionStatus?.[state.uid] === true;

    let votingBody = "";
    if (!participated) {
      votingBody = `
        <div class="wait-state">
          <div class="wait-icon">—</div>
          <strong>Você não respondeu esta rodada</strong>
          <p class="muted">Aguarde o resultado. Você volta a participar normalmente na próxima rodada.</p>
        </div>`;
    } else if (!myChoice) {
      votingBody = `<div class="wait-state"><div class="loader"></div><p class="muted">Carregando sua opção de voto...</p></div>`;
    } else {
      const choiceHtml = choices.map(([choiceId, choice]) => {
        const own = choiceId === myChoice;
        const selected = choiceId === myVote;
        return `
          <button class="choice-card ${own ? "own" : ""} ${selected ? "selected" : ""}" data-choice-id="${escapeHtml(choiceId)}" ${own || myVote ? "disabled" : ""}>
            <span class="choice-text">${escapeHtml(choice.text)}</span>
            <span class="choice-note">${own ? "sua resposta" : selected ? "seu voto" : "votar"}</span>
          </button>`;
      }).join("");

      votingBody = `
        <div class="answer-area">
          <p class="eyebrow">Votação anônima</p>
          <h3 style="margin:7px 0 0">Qual é a melhor resposta?</h3>
          <p class="muted">O autor só será revelado no resultado. Você não pode votar na própria resposta.</p>
          <div class="choice-list">${choiceHtml || '<p class="muted">Carregando opções...</p>'}</div>
          ${myVote ? '<div class="notice" style="margin-top:14px">Voto confirmado. Aguardando os outros jogadores.</div>' : ''}
        </div>`;
    }

    const main = `
      <div class="panel round-card">
        ${renderRoundHeader()}
        ${votingBody}
      </div>`;
    return renderRoomShell(main);
  }

  function renderScoring() {
    const main = `
      <div class="panel round-card">
        ${renderRoundHeader()}
        <div class="wait-state">
          <div class="loader"></div>
          <strong>Apurando os votos</strong>
          <p class="muted">Os votos já estão travados. Agora o resultado e a pontuação estão sendo calculados.</p>
        </div>
      </div>`;
    return renderRoomShell(main);
  }

  function renderResult(finished) {
    const result = state.roundResult;
    if (!result) return renderRoomShell(`<div class="panel wait-state"><div class="loader"></div><p class="muted">Fechando a votação...</p></div>`);

    const ranking = Array.isArray(result.ranking) ? result.ranking : Object.values(result.ranking || {});
    if (result.cancelled === true) {
      let cancelled = `
        <div class="panel round-card">
          ${renderRoundHeader()}
          <div class="wait-state">
            <div class="wait-icon">—</div>
            <strong>Rodada cancelada</strong>
            <p class="muted">Nenhum ponto foi distribuído. O host pode iniciar a próxima rodada.</p>
          </div>
        </div>`;
      if (isHost()) cancelled += '<div class="action-row"><button id="nextRoundBtn" class="btn btn-primary" type="button">Próxima rodada</button></div>';
      else cancelled += '<div class="panel wait-state"><div class="wait-icon">…</div><strong>Aguardando próxima rodada</strong><p class="muted">O host controla o avanço.</p></div>';
      return renderRoomShell(cancelled);
    }
    const rows = ranking.map((item, index) => {
      const namesRaw = Array.isArray(item.ownerNames) ? item.ownerNames : Object.values(item.ownerNames || {});
      const ownerNames = namesRaw.length ? namesRaw.join(" + ") : (item.ownerName || "Jogador");
      const ownerCount = Number(item.ownerCount || namesRaw.length || 1);
      return `
      <div class="result-row">
        <div class="result-position">${index + 1}º</div>
        <div>
          <div class="result-answer">${escapeHtml(item.text)}</div>
          <div class="result-owner">${escapeHtml(ownerNames)}${ownerCount > 1 ? ` · ${ownerCount} respostas iguais` : ""}</div>
        </div>
        <div class="result-votes">
          ${Number(item.votes || 0)} voto${Number(item.votes || 0) === 1 ? "" : "s"}
          ${Number(item.points || 0) > 0 ? `<div class="points-gain">+${Number(item.points)} pt${Number(item.points) === 1 ? "" : "s"}${ownerCount > 1 ? " para cada" : ""}</div>` : ""}
        </div>
      </div>`;
    }).join("");

    let header = `
      <div class="panel round-card">
        ${renderRoundHeader()}
        <div class="answer-area">
          <p class="eyebrow">Resultado da rodada</p>
          <h3 style="margin:7px 0 0">Votos revelados</h3>
          <div class="result-list">${rows}</div>
        </div>
      </div>`;

    if (finished) {
      const winner = state.players?.[state.meta?.winnerUid];
      header = `
        <div class="panel winner-panel">
          <div class="winner-kicker">Campeão</div>
          <h1 class="winner-name">${escapeHtml(winner?.name || "Vencedor")}</h1>
          <div class="winner-score">${Number(winner?.score || 0)} pontos</div>
        </div>
        ${header}`;
    } else if (state.meta?.suddenDeath) {
      header = `<div class="notice" style="margin-bottom:14px"><strong>Desempate:</strong> mais de um jogador chegou à meta com a mesma pontuação. A partida continua até existir um líder isolado.</div>${header}`;
    }

    if (isHost()) {
      header += `
        <div class="action-row">
          ${finished
            ? '<button id="rematchBtn" class="btn btn-primary" type="button">Nova partida</button>'
            : '<button id="nextRoundBtn" class="btn btn-primary" type="button">Próxima rodada</button>'}
        </div>`;
    } else {
      header += `<div class="panel wait-state"><div class="wait-icon">…</div><strong>${finished ? "Aguardando nova partida" : "Aguardando próxima rodada"}</strong><p class="muted">O host controla o avanço.</p></div>`;
    }

    return renderRoomShell(header);
  }

  function bindDynamicEvents() {
    $("copyCodeBtn")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(state.roomCode); toast("Código copiado.", "success"); }
      catch { toast(`Código da sala: ${state.roomCode}`); }
    });

    $("scoreMinus")?.addEventListener("click", () => changeTargetScore(-1));
    $("scorePlus")?.addEventListener("click", () => changeTargetScore(1));

    document.querySelectorAll("[data-category]").forEach((input) => {
      input.addEventListener("change", () => updateCategory(input.dataset.category, input.checked));
    });

    $("startGameBtn")?.addEventListener("click", startNextRound);
    $("nextRoundBtn")?.addEventListener("click", startNextRound);
    $("rematchBtn")?.addEventListener("click", resetMatch);
    $("cancelRoundBtn")?.addEventListener("click", cancelRound);
    $("submitAnswerBtn")?.addEventListener("click", submitAnswer);
    $("answerInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAnswer(); });

    document.querySelectorAll("[data-choice-id]").forEach((button) => {
      button.addEventListener("click", () => submitVote(button.dataset.choiceId));
    });

    document.querySelectorAll("[data-kick-uid]").forEach((button) => {
      button.addEventListener("click", () => kickDisconnectedPlayer(button.dataset.kickUid));
    });

    $("leaveRoomBtn")?.addEventListener("click", leaveRoom);
    $("closeRoomBtn")?.addEventListener("click", closeRoom);
  }

  async function changeTargetScore(delta) {
    if (!isHost() || state.meta?.phase !== "lobby") return;
    const next = Math.max(3, Math.min(50, Number(state.config?.targetScore || 10) + delta));
    try { await roomRef("config/targetScore").set(next); }
    catch (err) { toast(humanizeFirebaseError(err), "error"); }
  }

  async function updateCategory(categoryId, enabled) {
    if (!isHost() || state.meta?.phase !== "lobby") return;
    try {
      if (categoryId === "geral" && enabled) {
        await roomRef("config/selectedCategories").set({ geral: true });
        return;
      }

      const current = { ...(state.config?.selectedCategories || {}) };
      delete current.geral;
      if (enabled) current[categoryId] = true;
      else delete current[categoryId];

      if (!Object.keys(current).length) {
        toast("Selecione pelo menos um tema.", "error");
        renderRoom();
        return;
      }
      await roomRef("config/selectedCategories").set(current);
    } catch (err) {
      toast(humanizeFirebaseError(err), "error");
    }
  }

  function pickQuestion() {
    const selected = selectedCategoryIds();
    const allowedCategories = selected.includes("geral")
      ? GAME_DATA.categories.filter((c) => c.id !== "geral").map((c) => c.id)
      : selected;

    const pool = GAME_DATA.questions.filter((q) => allowedCategories.includes(q.category));
    if (!pool.length) throw new Error("Não há perguntas para os temas selecionados.");

    const usedIds = new Set(Object.values(state.history || {}).map((h) => h?.questionId).filter(Boolean));
    let available = pool.filter((q) => !usedIds.has(q.id));
    if (!available.length) available = pool;

    const q = available[Math.floor(Math.random() * available.length)];
    const letters = String(q.letters || "ACDEFGILMNPRSTV");
    const letter = letters[Math.floor(Math.random() * letters.length)];
    return { ...q, letter };
  }

  async function startNextRound() {
    if (!isHost() || state.actionBusy) return;
    const phase = state.meta?.phase;
    if (!['lobby', 'result'].includes(phase)) return;

    const active = connectedPlayers();
    if (phase === "lobby" && active.length < Number(state.config?.minPlayers || 3)) {
      return toast("São necessários pelo menos 3 jogadores conectados.", "error");
    }
    if (active.length < 2) return toast("É preciso ter pelo menos 2 jogadores conectados para continuar.", "error");
    if (!selectedCategoryIds().length) return toast("Selecione pelo menos um tema.", "error");

    state.actionBusy = true;
    const button = $(phase === "lobby" ? "startGameBtn" : "nextRoundBtn");
    setBusy(button, true, "Preparando...");
    try {
      const question = pickQuestion();
      const roundNumber = Number(state.meta?.roundNumber || 0) + 1;
      const roundId = `r${roundNumber}_${Date.now().toString(36)}_${randomString(4)}`;
      const roundData = {
        roundId,
        roundNumber,
        questionId: question.id,
        category: question.category,
        prompt: question.prompt,
        letter: question.letter,
        createdAt: serverTimestamp()
      };

      const updates = {};
      updates[`roundPublic/${roundId}`] = roundData;
      updates[`history/${roundNumber}`] = { questionId: question.id, category: question.category, letter: question.letter };
      updates["meta/currentRoundId"] = roundId;
      updates["meta/roundNumber"] = roundNumber;
      updates["meta/phase"] = "answering";
      updates["meta/winnerUid"] = "";
      updates["meta/lastActionAt"] = serverTimestamp();
      await roomRef().update(updates);
    } catch (err) {
      console.error(err);
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function submitAnswer() {
    if (state.actionBusy || state.meta?.phase !== "answering" || state.submissionStatus?.[state.uid] === true) return;
    const input = $("answerInput");
    const button = $("submitAnswerBtn");
    const answer = String(input?.value || "").replace(/\s+/g, " ").trim();
    const letter = String(state.roundPublic?.letter || "").toUpperCase();

    if (answerRemainingMs() <= 0) return toast("O tempo para responder acabou.", "error");
    if (!answer || answer.length > 40) return toast("Digite uma resposta de até 40 caracteres.", "error");
    const first = normalizeText(answer).charAt(0).toUpperCase();
    if (first !== letter) return toast(`A resposta precisa começar com a letra ${letter}.`, "error");

    state.actionBusy = true;
    setBusy(button, true, "Enviando...");
    try {
      const roundId = state.meta.currentRoundId;
      const choiceId = state.privateChoiceId || choiceIdForAnswer(roundId, answer);

      if (!state.privateChoiceId) {
        await roomRef(`privateChoices/${roundId}/${state.uid}`).set(choiceId);
        state.privateChoiceId = choiceId;
      }

      const choiceRef = roomRef(`publicChoices/${roundId}/${choiceId}`);
      const existingChoice = await choiceRef.once("value");
      if (!existingChoice.exists()) {
        try {
          await choiceRef.set({
            text: answer,
            order: deterministicChoiceOrder(choiceId)
          });
        } catch (choiceErr) {
          // Duas respostas iguais podem tentar criar o mesmo grupo ao mesmo tempo.
          // Só uma criação vence; a confirmação abaixo valida que o grupo existe.
          const errorText = `${choiceErr?.code || ""} ${choiceErr?.message || ""}`.toLowerCase();
          if (!errorText.includes("permission")) throw choiceErr;
        }
      }

      await roomRef(`submissionStatus/${roundId}/${state.uid}`).set(true);
      state.myChoiceText = answer;
    } catch (err) {
      console.error(err);
      if (answerRemainingMs() <= 0) toast("O tempo para responder acabou.", "error");
      else toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function submitVote(choiceId) {
    if (state.actionBusy || state.meta?.phase !== "voting") return;
    if (!choiceId || choiceId === state.privateChoiceId) return;
    if (state.votes?.[state.uid]) return;

    state.actionBusy = true;
    try {
      const roundId = state.meta.currentRoundId;
      await roomRef(`votes/${roundId}/${state.uid}`).set({
        choiceId,
        createdAt: serverTimestamp()
      });
      await roomRef(`voteStatus/${roundId}/${state.uid}`).set(true);
    } catch (err) {
      console.error(err);
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
    }
  }

  async function cancelRound() {
    if (!isHost() || !["answering", "voting", "scoring"].includes(state.meta?.phase) || state.actionBusy) return;
    const roundId = state.meta?.currentRoundId;
    if (!roundId) return;

    state.actionBusy = true;
    const button = $("cancelRoundBtn");
    setBusy(button, true, "Cancelando...");
    try {
      const phaseSnap = await roomRef("meta/phase").once("value");
      if (!["answering", "voting", "scoring"].includes(phaseSnap.val())) return;
      await roomRef().update({
        [`roundResult/${roundId}`]: {
          roundId,
          cancelled: true,
          ranking: [],
          createdAt: serverTimestamp()
        },
        "meta/phase": "result",
        "meta/lastActionAt": serverTimestamp()
      });
    } catch (err) {
      console.error(err);
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function resetMatch() {
    if (!isHost() || state.meta?.phase !== "finished" || state.actionBusy) return;
    state.actionBusy = true;
    const button = $("rematchBtn");
    setBusy(button, true, "Reiniciando...");
    try {
      const updates = {
        "meta/phase": "lobby",
        "meta/roundNumber": 0,
        "meta/currentRoundId": "",
        "meta/winnerUid": "",
        "meta/suddenDeath": false,
        "meta/lastActionAt": serverTimestamp(),
        history: null,
        roundPublic: null,
        privateChoices: null,
        publicChoices: null,
        submissionStatus: null,
        votes: null,
        voteStatus: null,
        roundResult: null
      };
      Object.keys(state.players || {}).forEach((uid) => { updates[`players/${uid}/score`] = 0; });
      await roomRef().update(updates);
    } catch (err) {
      toast(humanizeFirebaseError(err), "error");
    } finally {
      state.actionBusy = false;
      setBusy(button, false);
    }
  }

  async function cancelPresenceHook() {
    if (!state.onDisconnectRef) return;
    try { await state.onDisconnectRef.onDisconnect().cancel(); } catch {}
    state.onDisconnectRef = null;
  }

  async function leaveRoom() {
    if (!state.roomCode) return;

    try {
      const phase = state.meta?.phase;
      const me = myPlayer();
      const mySlotId = String(me?.slot ?? "");
      const others = connectedPlayers()
        .filter((p) => p.uid !== state.uid)
        .sort((a, b) => Number(a.joinedAt || 0) - Number(b.joinedAt || 0));

      if (isHost()) {
        if (phase === "lobby" && Object.keys(state.players || {}).length === 1) {
          await closeRoom();
          return;
        }

        if (others.length) {
          const nextHostUid = others[0].uid;
          const updates = { "meta/hostUid": nextHostUid };
          if (phase === "lobby") {
            updates[`players/${state.uid}`] = null;
            if (mySlotId) updates[`slots/${mySlotId}`] = null;
          } else {
            updates[`players/${state.uid}/connected`] = false;
          }
          await roomRef().update(updates);
          await cancelPresenceHook();
          leaveLocalRoom();
          return;
        }

        await roomRef(`players/${state.uid}/connected`).set(false);
        await cancelPresenceHook();
        leaveLocalRoom();
        return;
      }

      if (phase === "lobby") {
        const updates = { [`players/${state.uid}`]: null };
        if (mySlotId) updates[`slots/${mySlotId}`] = null;
        await roomRef().update(updates);
        await cancelPresenceHook();
        leaveLocalRoom();
      } else {
        await roomRef(`players/${state.uid}/connected`).set(false);
        await cancelPresenceHook();
        leaveLocalRoom();
      }
    } catch (err) {
      toast(humanizeFirebaseError(err), "error");
    }
  }

  async function kickDisconnectedPlayer(uid) {
    if (!isHost() || state.meta?.phase !== "lobby" || !uid || uid === state.meta.hostUid) return;
    const player = state.players?.[uid];
    if (!player || player.connected) return toast("Esse jogador já está conectado novamente.", "error");
    try {
      const updates = { [`players/${uid}`]: null };
      if (player.slot !== undefined && player.slot !== null && String(player.slot) !== "") {
        updates[`slots/${String(player.slot)}`] = null;
      }
      await roomRef().update(updates);
      toast("Jogador desconectado removido.", "success");
    } catch (err) {
      toast(humanizeFirebaseError(err), "error");
    }
  }

  async function closeRoom() {
    if (!isHost()) return;
    try {
      await cancelPresenceHook();
      await roomRef().remove();
      leaveLocalRoom();
      toast("Sala encerrada.", "success");
    } catch (err) {
      toast(humanizeFirebaseError(err), "error");
    }
  }

  function leaveLocalRoom() {
    detachAllListeners();
    state.roomCode = null;
    state.meta = null;
    state.config = null;
    state.players = {};
    state.activeRoundId = null;
    state.activeRoundKey = null;
    state.onDisconnectRef = null;
    if (state.hostWatchdog) clearInterval(state.hostWatchdog);
    state.hostWatchdog = null;
    if (state.answerTimerInterval) clearInterval(state.answerTimerInterval);
    state.answerTimerInterval = null;
    clearSession();
    $("roomBadge").classList.add("hidden");
    $("roomBadge").textContent = "";
    showScreen("homeScreen");
  }

  function handleRoomClosed() {
    if (!state.roomCode) return;
    toast("A sala foi encerrada pelo host.", "error");
    leaveLocalRoom();
  }

  function humanizeFirebaseError(err) {
    const code = String(err?.code || "").toLowerCase();
    const message = String(err?.message || "").toLowerCase();
    if (code.includes("permission-denied") || code.includes("permission_denied") || message.includes("permission denied")) {
      return "A ação foi bloqueada pelas regras do Firebase. Publique o firebase.rules.json desta mesma versão do projeto.";
    }
    if (code.includes("auth/operation-not-allowed")) return "Ative o provedor de autenticação Anônima no Firebase Authentication.";
    if (code.includes("auth/invalid-api-key")) return "A apiKey do firebase-config.js é inválida.";
    if (code.includes("network") || message.includes("network")) return "Falha de conexão. Verifique sua internet e tente novamente.";
    return err?.message || "Ocorreu um erro inesperado.";
  }

  window.addEventListener("beforeunload", () => {
    // onDisconnect do Firebase é responsável por marcar o jogador offline.
  });

  init();
})();
