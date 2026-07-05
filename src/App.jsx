import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from "react";
import {
  Home, Users, Wallet, Repeat, Trophy, Swords, Coins, BookOpen,
  Plus, Trash2, Save, RotateCcw, AlertTriangle, CheckCircle2, X, ChevronRight, Lock, Unlock, KeyRound,
  Upload, Eye, Loader2, Pencil, Check, Download, MessageCircle, Search, UserCircle2, Send, CalendarClock
} from "lucide-react";
import { storage, subscribeToKey, supabaseUrl, supabaseAnonKey, listByPrefix } from "./storage.js";

/* ----------------------------- design tokens ----------------------------- */
const C = {
  bg: "#0B1E36",
  panel: "#12294B",
  panel2: "#173257",
  panelAlt: "#0F2340",
  border: "#2E4E7A",
  gold: "#E7C568",
  goldDim: "#B99A4E",
  text: "#E9F1FB",
  muted: "#9FB3CE",
  green: "#8FD19E",
  red: "#E8888A",
  dark: "#0B1220",
};

const money = (n) => `£${(Number(n) || 0).toFixed(2)}M`;
const roundUpTo250k = (n) => Math.ceil((Number(n) || 0) / 0.25) * 0.25;
const moneyK = (n) => `£${Math.round(Number(n) || 0)}k`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);

// Resize + compress an uploaded image client-side so proof photos stay small enough
// to save reliably (storage values are capped at 5MB, and phone photos routinely exceed that).
function compressImageFile(file, maxWidth = 1000, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("That doesn't look like a valid image."));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const PROOF_KEY = (fixtureId) => `eafc26-proof-${fixtureId}`;

// Every transfer goes through a two-stage ratification: the selling side is settled after
// 12 hours, but the buying side (the actual signing — squad placement, budget hit, tax) only
// becomes official after the full 24 hours.
const SELLER_CREDIT_MS = 12 * 60 * 60 * 1000;
const BUYER_RATIFY_MS = 24 * 60 * 60 * 1000;

function transferStatus(tx, nowMs) {
  const created = tx.createdAt || 0;
  const sellerDone = tx.sellerProcessed || nowMs - created >= SELLER_CREDIT_MS;
  const buyerDone = tx.buyerProcessed || nowMs - created >= BUYER_RATIFY_MS;
  if (buyerDone) return { label: "Ratified", tone: "green" };
  if (sellerDone) return { label: `Seller credited — buyer ratifies in ${formatCountdown(created + BUYER_RATIFY_MS - nowMs)}`, tone: "gold" };
  return { label: `Pending — seller credited in ${formatCountdown(created + SELLER_CREDIT_MS - nowMs)}`, tone: "muted" };
}

const N_TEAMS = 10;
const STARTER_SLOTS = 21;
const RESERVE_SLOTS = 5;
const BASE_WAGE_CAP = 2;
const NEXT_CAP_MAX = 3.75;
const NEXT_CAP_STEP = 0.25;
const NEXT_CAP_FLOOR = 1.5;

function nextSeasonCap(position, nTeams) {
  const cap = NEXT_CAP_MAX - (position - 1) * NEXT_CAP_STEP;
  return +Math.max(cap, NEXT_CAP_FLOOR).toFixed(2);
}

// End-of-season budget top-up: scales by final position, top team gets the most.
// Hand-tuned to land on clean round numbers (ending in 0 or 5) rather than perfectly even steps.
const SEASON_BOOST_MAX = 120; // £M for 1st place
const SEASON_BOOST_MIN = 40;  // £M for last place
const SEASON_BOOST_TABLE_10 = [120, 110, 100, 90, 80, 70, 60, 50, 45, 40];

function seasonBudgetBoost(position, nTeams) {
  if (nTeams === SEASON_BOOST_TABLE_10.length && position >= 1 && position <= nTeams) {
    return SEASON_BOOST_TABLE_10[position - 1];
  }
  if (nTeams <= 1) return SEASON_BOOST_MAX;
  const raw = SEASON_BOOST_MAX - (position - 1) * (SEASON_BOOST_MAX - SEASON_BOOST_MIN) / (nTeams - 1);
  return Math.round(raw / 5) * 5; // fall back to the nearest £5M for any other league size
}

function emptyPlayer() {
  return { name: "", position: "ST", rating: 75, club: "", age: 25, value: 0, wage: 0 };
}

function defaultTeams() {
  const names = ["Alex Turner", "Ben Carter", "Chris Wood", "Dan Foster", "Ellis Grant",
    "Frank Hayes", "George Miller", "Harry Lewis", "Ian Scott", "Jack Palmer"];
  return Array.from({ length: N_TEAMS }, (_, i) => ({
    id: `T${i + 1}`,
    name: `Team ${i + 1}`,
    manager: names[i],
    budget: 500,
    wageCap: BASE_WAGE_CAP,
    earned86: 0,
    notes: "",
  }));
}

function defaultSquads() {
  const squads = {};
  for (let i = 1; i <= N_TEAMS; i++) {
    squads[`T${i}`] = {
      starters: Array(STARTER_SLOTS).fill(null),
      reserves: Array(RESERVE_SLOTS).fill(null),
    };
  }
  return squads;
}

const POSITIONS = ["GK", "CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST", "CF"];

const STORAGE_KEY = "eafc26-league-state-v1";
const MY_TEAM_KEY = "eafc26-my-team"; // personal, per-device — not shared
const CHAT_SEEN_KEY = "eafc26-chat-last-seen"; // personal — for the unread-mentions badge
const NIGHTLY_BACKUP_PREFIX = "eafc26-nightly-backup-"; // written by the scheduled Edge Function

/* ------------------------------- small UI -------------------------------- */
function Panel({ children, style, accent, ...rest }) {
  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(14,26,45,0.92) 0%, rgba(7,15,27,0.92) 100%)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(231,197,104,0.28)",
        borderTop: `4px solid ${accent || C.gold}`,
        borderRadius: "2px 10px 2px 2px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)",
        clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, children, right }) {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
      <div className="flex items-center gap-3">
        <div style={{ width: 5, height: 22, background: C.gold, boxShadow: `0 0 10px ${C.gold}88` }} />
        {Icon && <Icon size={17} color={C.gold} />}
        <h2 style={{ color: "#fff", fontSize: 17, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>{children}</h2>
      </div>
      {right}
    </div>
  );
}

function Label({ children }) {
  return <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{children}</div>;
}

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      {label && <Label>{label}</Label>}
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  background: C.panelAlt,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.text,
  padding: "7px 10px",
  fontSize: 13.5,
  outline: "none",
};

function TextInput(props) {
  return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
}
function Select(props) {
  return <select {...props} style={{ ...inputStyle, ...(props.style || {}) }}>{props.children}</select>;
}

// Type a name, get matches from the imported player database (CM Tracker/Sofifa), pick one to
// auto-fill position/rating/club/age/wage/value on whatever form it's plugged into.
function PlayerAutocomplete({ value, onChange, onSelect, playerDatabase, placeholder }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const matches = useMemo(() => {
    const q = (value || "").trim().toLowerCase();
    if (!q || !playerDatabase || playerDatabase.length === 0) return [];
    return playerDatabase.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [value, playerDatabase]);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <TextInput
        placeholder={placeholder || "Start typing a player name…"}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8,
          maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}>
          {matches.map((p) => (
            <button key={p.id} onClick={() => { onSelect(p); setOpen(false); }}
              className="flex items-center justify-between"
              style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", borderBottom: `1px solid ${C.border}33`, padding: "8px 10px", cursor: "pointer", color: C.text, fontSize: 12.5 }}>
              <span>{p.name}</span>
              <span style={{ color: C.muted, fontSize: 11 }}>{p.position} · {p.rating} OVR{p.club ? ` · ${p.club}` : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", icon: Icon, disabled, style, title }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "center",
    borderRadius: 9, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid transparent", transition: "opacity .15s", opacity: disabled ? 0.5 : 1,
    fontSize: size === "sm" ? 12.5 : 13.5, padding: size === "sm" ? "6px 10px" : "8px 14px",
    whiteSpace: "nowrap",
  };
  const variants = {
    primary: { background: C.gold, color: C.dark },
    outline: { background: "transparent", color: C.text, border: `1px solid ${C.border}` },
    danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}55` },
    ghost: { background: "transparent", color: C.muted },
  };
  return (
    <button title={title} disabled={disabled} onClick={onClick} style={{ ...base, ...variants[variant], ...style }}>
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

function Pill({ children, tone = "muted" }) {
  const tones = {
    muted: { bg: `${C.border}55`, fg: C.muted },
    gold: { bg: `${C.gold}22`, fg: C.gold },
    green: { bg: `${C.green}22`, fg: C.green },
    red: { bg: `${C.red}22`, fg: C.red },
  };
  const t = tones[tone];
  return (
    <span style={{ background: t.bg, color: t.fg, borderRadius: 999, padding: "2px 10px", fontSize: 11.5, fontWeight: 700 }}>
      {children}
    </span>
  );
}

/* --------------------------------- App ----------------------------------- */
const SYNC_POLL_MS = 20000; // safety-net poll — realtime handles the fast path

export default function EafcLeagueApp() {
  const [teams, setTeams] = useState(defaultTeams());
  const [squads, setSquads] = useState(defaultSquads());
  const [transfers, setTransfers] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [prizes, setPrizes] = useState([]);
  const [events, setEvents] = useState([]);
  const [auctions, setAuctions] = useState([]);
  const [adminPin, setAdminPin] = useState("2026");
  const [season, setSeason] = useState(1);
  const [seasonHistory, setSeasonHistory] = useState([]);
  const [activity, setActivity] = useState([]);
  const [chat, setChat] = useState([]);
  const [playerDatabase, setPlayerDatabase] = useState([]); // imported from CM Tracker/Sofifa for autocomplete
  const [claimedTeams, setClaimedTeams] = useState({}); // { [teamId]: true } — which teams are already picked by someone
  const [chatLastSeen, setChatLastSeen] = useState(0); // personal — timestamp of last time this device checked chat
  const [mentionToasts, setMentionToasts] = useState([]); // ephemeral "flash" alerts for @team mentions
  const [myTeamId, setMyTeamId] = useState(null); // personal — which team is "me" on this device
  const [tab, setTab] = useState("dashboard");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [syncState, setSyncState] = useState("idle"); // idle | checking | updated
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Tracks the newest "savedAt" timestamp we know about, whether from our own last save or
  // someone else's. Used to decide whether an incoming poll actually has newer data.
  const knownSavedAtRef = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => { savingRef.current = saveState === "saving"; }, [saveState]);

  const applyRemoteData = useCallback((data) => {
    if (data.teams) setTeams(data.teams);
    if (data.squads) setSquads(data.squads);
    if (data.transfers) setTransfers(data.transfers);
    if (data.fixtures) setFixtures(data.fixtures);
    if (data.prizes) setPrizes(data.prizes);
    if (data.events) setEvents(data.events);
    if (data.auctions) setAuctions(data.auctions);
    if (data.adminPin) setAdminPin(data.adminPin);
    if (data.season) setSeason(data.season);
    if (data.seasonHistory) setSeasonHistory(data.seasonHistory);
    if (data.activity) setActivity(data.activity);
    if (data.chat) setChat(data.chat);
    if (data.playerDatabase) setPlayerDatabase(data.playerDatabase);
    if (data.claimedTeams) setClaimedTeams(data.claimedTeams);
  }, []);

  // load once
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY, true);
        if (res && res.value) {
          const data = JSON.parse(res.value);
          applyRemoteData(data);
          knownSavedAtRef.current = data.savedAt || Date.now();
          setLastSyncedAt(knownSavedAtRef.current);
        }
      } catch (e) {
        // no saved data yet — fine, start fresh
      }
      try {
        const mine = await storage.get(MY_TEAM_KEY, false);
        if (mine && mine.value) setMyTeamId(mine.value);
      } catch (e) {
        // no personal team picked yet
      }
      try {
        const seen = await storage.get(CHAT_SEEN_KEY, false);
        if (seen && seen.value) setChatLastSeen(Number(seen.value) || 0);
      } catch (e) {
        // never checked chat yet
      }
      setLoaded(true);
    })();
  }, [applyRemoteData]);

  // autosave (debounced)
  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        const savedAt = Date.now();
        await storage.set(
          STORAGE_KEY,
          JSON.stringify({ teams, squads, transfers, fixtures, prizes, events, auctions, adminPin, season, seasonHistory, activity, chat, playerDatabase, claimedTeams, savedAt }),
          true
        );
        knownSavedAtRef.current = savedAt;
        setLastSyncedAt(savedAt);
        setSaveState("saved");
      } catch (e) {
        setSaveState("idle");
      }
    }, 500);
    return () => clearTimeout(t);
  }, [teams, squads, transfers, fixtures, prizes, events, auctions, adminPin, season, seasonHistory, activity, chat, playerDatabase, claimedTeams, loaded]);

  // live sync: poll for other people's changes and pull them in automatically. Skipped while we
  // have our own unsaved edit in flight, so we don't clobber it with a slightly stale copy.
  const pullLatest = useCallback(async (manual = false) => {
    if (savingRef.current) return;
    setSyncState("checking");
    try {
      const res = await storage.get(STORAGE_KEY, true);
      if (res && res.value) {
        const data = JSON.parse(res.value);
        const remoteSavedAt = data.savedAt || 0;
        if (remoteSavedAt > knownSavedAtRef.current) {
          applyRemoteData(data);
          knownSavedAtRef.current = remoteSavedAt;
        }
      }
      setLastSyncedAt(Date.now()); // reflects "last time we checked", not just "last time data changed"
      setSyncState("idle");
    } catch (e) {
      setSyncState("idle");
    }
  }, [applyRemoteData]);

  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => pullLatest(false), SYNC_POLL_MS);
    return () => clearInterval(t);
  }, [loaded, pullLatest]);

  // Real-time: push updates the instant someone else saves, rather than waiting for the next
  // poll. The interval above stays on as a safety net in case a realtime event gets missed.
  useEffect(() => {
    if (!loaded) return;
    const unsubscribe = subscribeToKey(STORAGE_KEY, (row) => {
      if (!row || !row.value) return;
      try {
        const data = JSON.parse(row.value);
        const remoteSavedAt = data.savedAt || 0;
        if (remoteSavedAt > knownSavedAtRef.current && !savingRef.current) {
          applyRemoteData(data);
          knownSavedAtRef.current = remoteSavedAt;
          setLastSyncedAt(Date.now());
        }
      } catch (e) {
        // ignore malformed payloads
      }
    });
    return unsubscribe;
  }, [loaded, applyRemoteData]);

  const chooseMyTeam = async (teamId) => {
    if (teamId && claimedTeams[teamId] && teamId !== myTeamId) {
      return "That team's already been picked by someone else.";
    }
    setClaimedTeams((prev) => {
      const next = { ...prev };
      if (myTeamId) delete next[myTeamId]; // release whatever we had before
      if (teamId) next[teamId] = true;
      return next;
    });
    setMyTeamId(teamId);
    try { await storage.set(MY_TEAM_KEY, teamId || "", false); } catch (e) { /* best effort */ }
    return null;
  };

  // Shared activity log — kept short so it stays useful rather than becoming noise.
  const logActivity = useCallback((text, type = "info") => {
    setActivity((a) => [{ id: uid(), text, type, time: Date.now() }, ...a].slice(0, 200));
  }, []);

  const teamById = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);

  const markChatSeen = useCallback(async () => {
    const now = Date.now();
    setChatLastSeen(now);
    try { await storage.set(CHAT_SEEN_KEY, String(now), false); } catch (e) { /* best effort */ }
  }, []);

  const unreadMentions = useMemo(
    () => (myTeamId ? chat.filter((m) => m.taggedTeam === myTeamId && m.time > chatLastSeen) : []),
    [chat, myTeamId, chatLastSeen]
  );

  // Flash a toast the moment a new message tagging your team arrives, regardless of which tab
  // you're on — this is the "notification" half; the nav badge (via unreadMentions) is the other.
  const seenChatIdsRef = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (seenChatIdsRef.current === null) {
      // first run after load — remember what's already there so we don't toast for old messages
      seenChatIdsRef.current = new Set(chat.map((m) => m.id));
      return;
    }
    const freshMentions = chat.filter((m) => !seenChatIdsRef.current.has(m.id) && m.taggedTeam === myTeamId);
    chat.forEach((m) => seenChatIdsRef.current.add(m.id));
    if (freshMentions.length > 0 && myTeamId) {
      setMentionToasts((all) => [...all, ...freshMentions.map((m) => ({ id: uid(), text: m.text, author: m.author }))]);
    }
  }, [chat, loaded, myTeamId]);

  const dismissToast = (id) => setMentionToasts((all) => all.filter((t) => t.id !== id));

  useEffect(() => {
    if (mentionToasts.length === 0) return;
    const timers = mentionToasts.map((t) => setTimeout(() => dismissToast(t.id), 8000));
    return () => timers.forEach(clearTimeout);
  }, [mentionToasts]);

  // If someone picked a team before this feature existed, register their existing pick so it
  // shows as taken for everyone else too, without needing them to re-pick.
  useEffect(() => {
    if (!loaded || !myTeamId) return;
    if (!claimedTeams[myTeamId]) {
      setClaimedTeams((prev) => ({ ...prev, [myTeamId]: true }));
    }
  }, [loaded, myTeamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ticking clock so budgets/statuses recompute live as the 12h/24h ratification windows pass.
  const [nowTick, setNowTick] = useState(Date.now());
  const transfersRef = useRef(transfers);
  const squadsRef = useRef(squads);
  useEffect(() => { transfersRef.current = transfers; }, [transfers]);
  useEffect(() => { squadsRef.current = squads; }, [squads]);

  useEffect(() => {
    const t = setInterval(() => {
      const nowMs = Date.now();
      setNowTick(nowMs);

      const currentTx = transfersRef.current;
      const sellerRemovals = []; // { teamId, playerName }
      let txChanged = false;
      const newTx = currentTx.map((tx) => {
        const created = tx.createdAt || 0;
        if (!tx.sellerProcessed && teamById[tx.from] && nowMs - created >= SELLER_CREDIT_MS) {
          sellerRemovals.push({ teamId: tx.from, playerName: tx.player });
          txChanged = true;
          return { ...tx, sellerProcessed: true };
        }
        return tx;
      });

      // Build the post-removal squad snapshot locally so buyer placements below see accurate free slots.
      let nextSquads = squadsRef.current;
      if (sellerRemovals.length) {
        nextSquads = { ...nextSquads };
        sellerRemovals.forEach(({ teamId, playerName }) => {
          if (!nextSquads[teamId]) return;
          nextSquads = {
            ...nextSquads,
            [teamId]: {
              starters: nextSquads[teamId].starters.map((p) => (p && p.name === playerName ? null : p)),
              reserves: nextSquads[teamId].reserves.map((p) => (p && p.name === playerName ? null : p)),
            },
          };
        });
      }

      let squadsChanged = sellerRemovals.length > 0;
      const finalTx = newTx.map((tx) => {
        const created = tx.createdAt || 0;
        if (!tx.buyerProcessed && teamById[tx.to] && nowMs - created >= BUYER_RATIFY_MS) {
          // Tax-only auction-loss charges have no player to place — just mark them ratified.
          if (tx.from === "AUCTION_LOSS") { txChanged = true; return { ...tx, buyerProcessed: true }; }
          const team = nextSquads[tx.to];
          const si = team.starters.findIndex((p) => !p);
          const group = si !== -1 ? "starters" : null;
          const ri = group ? -1 : team.reserves.findIndex((p) => !p);
          const targetGroup = group || (ri !== -1 ? "reserves" : null);
          if (!targetGroup) return tx; // squad still full — retry on the next tick
          const idx = targetGroup === "starters" ? si : ri;
          const playerObj = {
            name: tx.player, position: tx.position, rating: tx.rating,
            club: tx.club, age: tx.age, value: tx.price, wage: tx.wage,
          };
          nextSquads = { ...nextSquads, [tx.to]: { ...nextSquads[tx.to], [targetGroup]: [...nextSquads[tx.to][targetGroup]] } };
          nextSquads[tx.to][targetGroup][idx] = playerObj;
          squadsChanged = true;
          txChanged = true;
          return { ...tx, buyerProcessed: true };
        }
        return tx;
      });

      if (squadsChanged) setSquads(nextSquads);
      if (txChanged) setTransfers(finalTx);
    }, 15000); // check every 15s — plenty for a 12h/24h window
    return () => clearInterval(t);
  }, [teamById]);

  /* ------------------------------ derived data ------------------------------ */
  const squadStats = useMemo(() => {
    const out = {};
    for (const t of teams) {
      const sq = squads[t.id] || { starters: [], reserves: [] };
      const all = [...sq.starters, ...sq.reserves].filter(Boolean);
      const filled = all.length;
      const value = all.reduce((s, p) => s + (Number(p.value) || 0), 0);
      const wageK = all.reduce((s, p) => s + (Number(p.wage) || 0), 0);
      const wageM = wageK / 1000;
      const rated86 = all.filter((p) => Number(p.rating) >= 86).length;
      out[t.id] = { filled, value, wageM, rated86, allowed86: NEXT_CAP_MAX === NEXT_CAP_MAX ? 3 + (t.earned86 || 0) : 3 };
    }
    return out;
  }, [teams, squads]);

  const budgetStats = useMemo(() => {
    const out = {};
    for (const t of teams) {
      const boughtFromOthers = transfers.filter(
        (tx) => tx.to === t.id && tx.from !== t.id && nowTick - (tx.createdAt || 0) >= BUYER_RATIFY_MS
      );
      const soldToOthersOrFA = transfers.filter(
        (tx) => tx.from === t.id && tx.to !== t.id && nowTick - (tx.createdAt || 0) >= SELLER_CREDIT_MS
      );
      const spent = boughtFromOthers.reduce((s, tx) => s + Number(tx.price || 0), 0);
      const tax = boughtFromOthers.reduce((s, tx) => s + Number(tx.tax || 0), 0);
      const received = soldToOthersOrFA
        .filter((tx) => teamById[tx.to]) // only real teams pay the seller
        .reduce((s, tx) => s + Number(tx.price || 0), 0);

      // Live auctions this team is currently winning aren't final yet, but the money and wage cost
      // are effectively spoken for — reflect that immediately rather than waiting for ratification.
      const leadingAuctions = auctions.filter(
        (a) => (a.status === "open" || a.status === "pending") && a.currentBidder === t.id
      );
      const committedSpend = leadingAuctions.reduce((s, a) => s + Number(a.currentBid || 0), 0);
      const committedTax = leadingAuctions.reduce((s, a) => s + Math.max(Number(a.currentBid || 0) * 0.1, 0.25), 0);
      const committedWage = leadingAuctions.reduce((s, a) => s + Number(a.player?.wage || 0), 0) / 1000;

      const current = t.budget + received - spent - tax - committedSpend - committedTax;
      const wages = (squadStats[t.id] && squadStats[t.id].wageM) || 0;
      const wagesWithCommitted = wages + committedWage;
      out[t.id] = {
        spent, tax, received, current, wages,
        committedSpend, committedTax, committedWage, wagesWithCommitted,
        compliant: wagesWithCommitted <= t.wageCap,
      };
    }
    return out;
  }, [teams, transfers, teamById, squadStats, auctions, nowTick]);

  const standings = useMemo(() => {
    const rows = teams.map((t) => ({ id: t.id, w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0 }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const f of fixtures) {
      if (f.score1 === "" || f.score2 === "" || f.score1 == null || f.score2 == null) continue;
      const s1 = Number(f.score1), s2 = Number(f.score2);
      const r1 = byId[f.team1], r2 = byId[f.team2];
      if (!r1 || !r2) continue;
      r1.played++; r2.played++;
      r1.gf += s1; r1.ga += s2;
      r2.gf += s2; r2.ga += s1;
      if (s1 > s2) { r1.w++; r2.l++; }
      else if (s2 > s1) { r2.w++; r1.l++; }
      else { r1.d++; r2.d++; }
    }
    const table = rows.map((r) => ({
      ...r,
      gd: r.gf - r.ga,
      points: r.w * 3 + r.d,
    }));
    table.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
    return table.map((r, i) => ({ ...r, position: i + 1, nextCap: nextSeasonCap(i + 1, teams.length) }));
  }, [teams, fixtures]);

  const taxCollected = useMemo(
    () => transfers
      .filter((tx) => nowTick - (tx.createdAt || 0) >= BUYER_RATIFY_MS)
      .reduce((s, tx) => s + Number(tx.tax || 0), 0),
    [transfers, nowTick]
  );
  const prizeTotal = useMemo(
    () => taxCollected + prizes.reduce((s, p) => s + Number(p.amount || 0), 0),
    [taxCollected, prizes]
  );

  /* ------------------------------- mutators -------------------------------- */
  const renameTeam = (id, patch) => {
    setTeams((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const logTransfer = (form) => {
    const price = Number(form.price) || 0;
    const tax = price > 0 ? Math.max(price * 0.1, 0.25) : 0;
    const record = {
      id: uid(),
      date: form.date || todayISO(),
      player: form.name,
      // Full player details kept on the record so the signing can still be placed into the squad
      // once it's ratified, even though that happens later rather than immediately.
      position: form.position, rating: Number(form.rating) || 0, club: form.club,
      age: Number(form.age) || 0, wage: Number(form.wage) || 0,
      from: form.from,
      to: form.to,
      price,
      tax: +tax.toFixed(3),
      finalCost: +(price + tax).toFixed(3),
      notes: form.notes || "",
      createdAt: Date.now(),
      sellerProcessed: false,
      buyerProcessed: false,
    };
    setTransfers((tx) => [record, ...tx]);
    const fromName = form.from === "FA" ? "Non OCM" : teamById[form.from]?.name || form.from;
    const toName = form.to === "FA" ? "Non OCM" : teamById[form.to]?.name || form.to;
    logActivity(`Transfer logged: ${form.name} — ${fromName} → ${toName} (${money(price)})`, "transfer");
    return null;
  };

  // Admin-only: the "Instant Transfer" tool is for player rewards / manual awards outside the
  // normal bidding process (no competing bids), so it's PIN-gated rather than open to everyone.
  const logAdminReward = (pinAttempt, form) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    if (!form.name || !form.name.trim()) return "Enter a player name.";
    if (form.from === form.to) return "From and To can't be the same team.";
    return logTransfer(form);
  };

  const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;

  const createAuction = (form) => {
    if (!form.name.trim()) return "Enter a player name.";
    if (!form.startingBidder) return "Choose which team is making the opening bid.";
    if (form.startingBidder === form.seller) return "The opening bidder can't be the same team as the seller.";
    const minBid = Math.max(Number(form.minBid) || 0, 0.25);
    const needsApproval = teamById[form.seller] ? true : false; // real team owns this player — they must accept first
    const auction = {
      id: uid(),
      player: {
        name: form.name, position: form.position, rating: Number(form.rating) || 0,
        club: form.club, age: Number(form.age) || 0, wage: Number(form.wage) || 0,
      },
      seller: form.seller,
      minBid,
      currentBid: minBid,
      currentBidder: form.startingBidder,
      bidsByTeam: { [form.startingBidder]: minBid }, // teamId -> that team's own highest bid in this auction
      history: [{ id: uid(), team: form.startingBidder, amount: minBid, time: Date.now() }],
      // Bidding (and the 24h clock) only starts once the owning team accepts — free agents need no approval.
      deadline: needsApproval ? null : Date.now() + AUCTION_DURATION_MS,
      status: needsApproval ? "pending" : "open",
      winner: null,
      winningBid: null,
    };
    setAuctions((all) => [auction, ...all]);
    return null;
  };

  const respondToAuction = (auctionId, accept) => {
    let err = null;
    setAuctions((all) => all.map((a) => {
      if (a.id !== auctionId) return a;
      if (a.status !== "pending") { err = "This auction isn't waiting for a decision."; return a; }
      if (!accept) { return { ...a, status: "declined" }; }
      return { ...a, status: "open", deadline: Date.now() + AUCTION_DURATION_MS };
    }));
    return err;
  };

  const placeBid = (auctionId, teamId, amount) => {
    const amt = Number(amount);
    let err = null;
    setAuctions((all) => all.map((a) => {
      if (a.id !== auctionId) return a;
      if (a.status === "pending") { err = `Waiting on ${teamById[a.seller]?.name || "the seller"} to accept the opening bid before anyone else can bid.`; return a; }
      if (a.status !== "open") { err = "This auction has already closed."; return a; }
      if (Date.now() >= a.deadline) { err = "Time's up on this auction — finalize it before bidding again."; return a; }
      if (!teamId) { err = "Choose which team is bidding."; return a; }
      if (teamId === a.currentBidder) { err = "That team already holds the highest bid."; return a; }
      const required = a.currentBid > 0 ? a.currentBid + 0.25 : Math.max(a.minBid, 0.25);
      if (!amt || amt < required - 0.001) { err = `Bid must be at least ${money(required)} (£250k above the current bid).`; return a; }
      const bidsByTeam = { ...a.bidsByTeam, [teamId]: Math.max(a.bidsByTeam[teamId] || 0, amt) };
      return {
        ...a,
        currentBid: amt,
        currentBidder: teamId,
        bidsByTeam,
        history: [{ id: uid(), team: teamId, amount: amt, time: Date.now() }, ...a.history],
        deadline: Date.now() + AUCTION_DURATION_MS, // every new highest bid resets the 24h clock
      };
    }));
    return err;
  };

  // Admin-only: remove a specific bid (e.g. a mis-click or joke bid) and recompute who's currently
  // winning from whatever bids remain.
  const deleteBid = (auctionId, bidId, pinAttempt) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    let err = null;
    setAuctions((all) => all.map((a) => {
      if (a.id !== auctionId) return a;
      if (a.status !== "open" && a.status !== "pending") { err = "Can't edit bids on a closed auction."; return a; }
      if (!a.history.some((h) => h.id === bidId)) { err = "Bid not found — it may already be removed."; return a; }
      const remaining = a.history.filter((h) => h.id !== bidId);

      if (remaining.length === 0) {
        // No bids left at all — a pending proposal has nothing to approve, so cancel it;
        // a live auction just resets to "no bids yet" and stays open for fresh bids.
        return a.status === "pending"
          ? { ...a, history: remaining, bidsByTeam: {}, currentBid: 0, currentBidder: null, status: "declined" }
          : { ...a, history: remaining, bidsByTeam: {}, currentBid: 0, currentBidder: null };
      }

      // Replay the remaining bids oldest-first to rebuild current state accurately.
      const chronological = [...remaining].reverse();
      const bidsByTeam = {};
      let currentBid = 0, currentBidder = null;
      chronological.forEach((h) => {
        bidsByTeam[h.team] = Math.max(bidsByTeam[h.team] || 0, h.amount);
        currentBid = h.amount;
        currentBidder = h.team;
      });
      return { ...a, history: remaining, bidsByTeam, currentBid, currentBidder };
    }));
    return err;
  };

  // Open to everyone — fixes a typo in the player's name on a bid that hasn't closed yet.
  const editAuctionPlayerName = (auctionId, newName) => {
    if (!newName || !newName.trim()) return "Enter a name.";
    let err = null;
    setAuctions((all) => all.map((a) => {
      if (a.id !== auctionId) return a;
      if (a.status !== "open" && a.status !== "pending") { err = "Can't edit a closed auction."; return a; }
      return { ...a, player: { ...a.player, name: newName.trim() } };
    }));
    return err;
  };

  const finalizeAuction = (auctionId) => {
    const auction = auctions.find((a) => a.id === auctionId);
    if (!auction) return "Auction not found.";
    if (auction.status === "pending") return "Still waiting on the owning team to accept the opening bid.";
    if (auction.status !== "open") return "This auction has already been finalized or declined.";
    if (Date.now() < auction.deadline) return "This auction is still live.";

    const bidders = Object.keys(auction.bidsByTeam);
    if (bidders.length === 0) {
      setAuctions((all) => all.map((a) => (a.id === auctionId ? { ...a, status: "closed" } : a)));
      return null;
    }

    const winner = auction.currentBidder;
    const winningBid = auction.currentBid;

    // Winning bid: normal transfer (moves the player, charges bid + tax) — this already logs
    // a "Transfer logged" activity entry, so no need for a separate auction-specific one.
    logTransfer({
      date: todayISO(), from: auction.seller, to: winner, name: auction.player.name,
      position: auction.player.position, rating: auction.player.rating, club: auction.player.club,
      age: auction.player.age, wage: auction.player.wage, price: winningBid,
      notes: `Won auction for ${auction.player.name}`,
    });

    // Every other bidder pays 10% tax (min £0.25M) on their own highest bid, no player received.
    // This tax-only charge feeds straight into the prize pool once ratified, same as any other transfer tax.
    const losingCharges = bidders
      .filter((teamId) => teamId !== winner)
      .map((teamId) => {
        const bid = auction.bidsByTeam[teamId];
        const tax = Math.max(bid * 0.1, 0.25);
        return {
          id: uid(),
          date: todayISO(),
          player: auction.player.name,
          from: "AUCTION_LOSS",
          to: teamId,
          price: 0,
          tax: +tax.toFixed(3),
          finalCost: +tax.toFixed(3),
          notes: `Losing bid tax — ${auction.player.name} auction (highest bid ${money(bid)})`,
          createdAt: Date.now(),
          sellerProcessed: true, // no seller side to this charge
          buyerProcessed: false,
        };
      });
    if (losingCharges.length) {
      setTransfers((tx) => [...losingCharges, ...tx]);
    }

    setAuctions((all) => all.map((a) => (a.id === auctionId ? { ...a, status: "closed", winner, winningBid } : a)));
    return null;
  };

  const resetAll = async (pinAttempt) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    if (!window.confirm("Reset ALL league data (teams, squads, transfers, fixtures, prizes)? This can't be undone.")) return null;
    setTeams(defaultTeams());
    setSquads(defaultSquads());
    setTransfers([]);
    setFixtures([]);
    setPrizes([]);
    setEvents([]);
    setAuctions([]);
    setSeason(1);
    setSeasonHistory([]);
    return null;
  };

  // Locks in final standings, applies each team's new wage cap for the next season, archives
  // this season's fixtures/transfers/prizes for the record, and starts a clean season. Squads
  // (players) carry over — only the season-specific numbers reset.
  const endSeason = (pinAttempt) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    const liveAuctions = auctions.filter((a) => a.status === "open" || a.status === "pending");
    if (liveAuctions.length > 0) {
      return `Resolve ${liveAuctions.length} live auction${liveAuctions.length === 1 ? "" : "s"} first (finalize or let the seller decline) before ending the season.`;
    }
    if (!window.confirm(
      `End Season ${season} and start Season ${season + 1}? This locks in final standings, tops up each team's leftover budget by position (£${SEASON_BOOST_MAX}M for 1st down to £${SEASON_BOOST_MIN}M for last), applies next season's wage caps, and archives this season's fixtures/transfers/prizes. Squads carry over unchanged.`
    )) return null;

    const finalStandings = standings.map((r) => ({
      teamId: r.id, teamName: teamById[r.id]?.name, manager: teamById[r.id]?.manager,
      position: r.position, played: r.played, points: r.points, gd: r.gd,
      nextSeasonWageCap: r.nextCap, budgetBoost: seasonBudgetBoost(r.position, teams.length),
    }));

    setSeasonHistory((h) => [{
      id: uid(), season, endedAt: Date.now(), standings: finalStandings,
      fixtures, transfers, prizes, taxCollected,
    }, ...h]);

    setTeams((ts) => ts.map((t) => {
      const row = standings.find((r) => r.id === t.id);
      const leftover = (budgetStats[t.id] && budgetStats[t.id].current) ?? t.budget;
      const boost = row ? seasonBudgetBoost(row.position, teams.length) : 0;
      return { ...t, budget: +(leftover + boost).toFixed(2), wageCap: row ? row.nextCap : t.wageCap };
    }));

    setFixtures([]);
    setTransfers([]);
    setPrizes([]);
    setAuctions((all) => all.filter((a) => a.status !== "closed" && a.status !== "declined")); // clear resolved history

    setSeason((s) => s + 1);
    return null;
  };

  const changeAdminPin = (currentPin, newPin) => {
    if (currentPin !== adminPin) return "Current PIN is incorrect.";
    if (!newPin || newPin.trim().length < 4) return "New PIN must be at least 4 characters.";
    setAdminPin(newPin.trim());
    return null;
  };

  // Downloads everything (squads, budgets, transfers, fixtures, prizes, auctions) as a JSON file
  // the admin can keep somewhere safe — a real backup outside the app's own storage.
  const exportBackup = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      teams, squads, transfers, fixtures, prizes, events, auctions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `eafc26-league-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const applyBackupData = (data) => {
    setTeams(data.teams || defaultTeams());
    setSquads(data.squads || defaultSquads());
    setTransfers(data.transfers || []);
    setFixtures(data.fixtures || []);
    setPrizes(data.prizes || []);
    setEvents(data.events || []);
    setAuctions(data.auctions || []);
  };

  // Restores from a previously exported backup file. PIN-gated since it overwrites live data.
  const restoreBackup = (pinAttempt, fileText) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    let data;
    try {
      data = JSON.parse(fileText);
    } catch (e) {
      return "That doesn't look like a valid backup file (couldn't read it as JSON).";
    }
    if (!data || !Array.isArray(data.teams) || !data.squads) {
      return "That file doesn't look like an EAFC 26 league backup.";
    }
    if (!window.confirm("Restore this backup? It will replace all current league data for everyone using this app.")) {
      return null;
    }
    applyBackupData(data);
    return null;
  };

  // Restores from one of the automatic nightly backups (written server-side by a scheduled
  // Edge Function). PIN-gated for the same reason as the manual restore.
  const restoreFromNightlyBackup = async (pinAttempt, key) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    if (!window.confirm(`Restore the backup from "${key.replace(NIGHTLY_BACKUP_PREFIX, "")}"? This replaces all current league data for everyone using this app.`)) {
      return null;
    }
    try {
      const res = await storage.get(key, true);
      if (!res || !res.value) return "Couldn't find that backup.";
      const data = JSON.parse(res.value);
      applyBackupData(data);
      return null;
    } catch (e) {
      return "Couldn't load that backup — try again.";
    }
  };

  // Replaces or merges the imported player reference database (from CM Tracker, Sofifa, etc.)
  // used to power autocomplete/autofill on player-name fields throughout the app.
  const importPlayerDatabase = (pinAttempt, players, mode) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    if (!Array.isArray(players) || players.length === 0) return "No players to import.";
    const cleaned = players.map((p) => ({
      id: uid(),
      name: (p.name || "").trim(),
      position: (p.position || "").trim().toUpperCase(),
      rating: Number(p.rating) || 0,
      club: (p.club || "").trim(),
      age: Number(p.age) || 0,
      value: Number(p.value) || 0,
      wage: Number(p.wage) || 0,
    })).filter((p) => p.name);
    if (mode === "replace") {
      setPlayerDatabase(cleaned);
    } else {
      setPlayerDatabase((existing) => {
        const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
        cleaned.forEach((p) => byName.set(p.name.toLowerCase(), p));
        return Array.from(byName.values());
      });
    }
    return null;
  };

  const clearPlayerDatabase = (pinAttempt) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    setPlayerDatabase([]);
    return null;
  };

  const clearActivity = (pinAttempt) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    setActivity([]);
    return null;
  };

  const addFundsToTeam = (pinAttempt, teamId, amount) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    const amt = Number(amount);
    if (!teamId) return "Choose a team.";
    if (!amt || isNaN(amt) || amt === 0) return "Enter a non-zero amount.";
    setTeams((ts) => ts.map((t) => (t.id === teamId ? { ...t, budget: +(t.budget + amt).toFixed(2) } : t)));
    return null;
  };

  const addEarned86Slot = (pinAttempt, teamId, amount) => {
    if (pinAttempt !== adminPin) return "Incorrect PIN.";
    const amt = Number(amount);
    if (!teamId) return "Choose a team.";
    if (!amt || isNaN(amt) || amt === 0) return "Enter a non-zero number of slots.";
    setTeams((ts) => ts.map((t) => (t.id === teamId ? { ...t, earned86: Math.max(0, (t.earned86 || 0) + amt) } : t)));
    return null;
  };

  /* --------------------------------- render --------------------------------- */
  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "squads", label: "Squad Lists", icon: Users },
    { id: "budgets", label: "Budgets & Wages", icon: Wallet },
    { id: "transfers", label: "Transfers", icon: Repeat },
    { id: "fixtures", label: "Fixtures", icon: Swords },
    { id: "standings", label: "Standings", icon: Trophy },
    { id: "prizes", label: "Prize Pool", icon: Coins },
    { id: "chat", label: "League Chat", icon: MessageCircle },
    { id: "rules", label: "Rules", icon: BookOpen },
  ];

  // Overscroll on some trackpads/phones briefly reveals the page behind the app, which defaults to
  // white — paint the real page background dark too so that "bounce" stays on-theme.
  useEffect(() => {
    const prevBodyBg = document.body.style.backgroundColor;
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    const prevBodyMargin = document.body.style.margin;
    document.body.style.backgroundColor = C.bg;
    document.documentElement.style.backgroundColor = C.bg;
    document.body.style.margin = "0";
    return () => {
      document.body.style.backgroundColor = prevBodyBg;
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.margin = prevBodyMargin;
    };
  }, []);

  return (
    <div style={{
      minHeight: "100vh",
      fontFamily: "'Oswald', 'Segoe UI', sans-serif",
      overscrollBehaviorX: "contain",
      background: `
        linear-gradient(115deg, rgba(231,197,104,0.10) 0%, rgba(231,197,104,0) 22%),
        radial-gradient(ellipse 1100px 600px at 50% 105%, rgba(60,150,95,0.22) 0%, rgba(60,150,95,0) 62%),
        radial-gradient(circle at 8% -5%, rgba(231,197,104,0.16) 0%, rgba(231,197,104,0) 38%),
        radial-gradient(circle at 92% -5%, rgba(231,197,104,0.16) 0%, rgba(231,197,104,0) 38%),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.012) 0px, rgba(255,255,255,0.012) 1px, transparent 1px, transparent 3px),
        linear-gradient(180deg, #04060a 0%, #081222 30%, #0a1a2e 65%, #0d2135 100%)
      `,
      backgroundAttachment: "fixed",
    }}>
      {/* top bar */}
      <div style={{ background: "#050a13", borderBottom: `1px solid rgba(231,197,104,0.22)`, padding: "14px 18px" }}>
        <div className="flex items-center justify-between flex-wrap gap-3" style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div className="flex items-center gap-2">
            <div style={{ width: 34, height: 34, borderRadius: 4, background: `linear-gradient(135deg, ${C.gold}, ${C.goldDim})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 14px ${C.gold}55` }}>
              <Trophy size={18} color={C.dark} />
            </div>
            <div>
              <div className="hud-font" style={{ color: "#fff", fontWeight: 600, fontSize: 18, letterSpacing: "0.03em" }}>EAFC 26 CUSTOM FANTASY LEAGUE</div>
              <div style={{ color: C.muted, fontSize: 11.5 }}>Season {season} · Private league app</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <MyTeamPicker teams={teams} myTeamId={myTeamId} chooseMyTeam={chooseMyTeam} claimedTeams={claimedTeams} />
            <SyncIndicator syncState={syncState} lastSyncedAt={lastSyncedAt} onRefresh={() => pullLatest(true)} />
            <SaveIndicator state={saveState} />
          </div>
        </div>
      </div>

      {/* tabs */}
      <div style={{ background: "#080f1c", borderBottom: `1px solid rgba(231,197,104,0.2)`, overflowX: "auto", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch" }}>
        <div className="flex hud-font" style={{ maxWidth: 1180, margin: "0 auto", padding: "0 18px" }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); if (t.id === "chat") markChatSeen(); }}
                className="flex items-center gap-1.5"
                style={{
                  padding: "13px 16px", background: "transparent", border: "none", cursor: "pointer", position: "relative",
                  color: active ? C.gold : "rgba(255,255,255,0.55)", fontWeight: 500, fontSize: 14,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  borderBottom: active ? `3px solid ${C.gold}` : "3px solid transparent",
                  boxShadow: active ? `0 3px 10px -2px ${C.gold}88` : "none",
                  whiteSpace: "nowrap",
                }}
              >
                <t.icon size={15} />
                {t.label}
                {t.id === "chat" && unreadMentions.length > 0 && (
                  <span style={{
                    position: "absolute", top: 6, right: 4, background: C.red, color: "#fff",
                    borderRadius: 999, fontSize: 10, fontWeight: 700, minWidth: 16, height: 16,
                    display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px",
                  }}>
                    {unreadMentions.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 18px 60px" }}>
        {tab === "dashboard" && (
          <Dashboard teams={teams} squads={squads} standings={standings} budgetStats={budgetStats} prizeTotal={prizeTotal}
            taxCollected={taxCollected} events={events} setEvents={setEvents} setTab={setTab}
            activity={activity} myTeamId={myTeamId} season={season} clearActivity={clearActivity} />
        )}
        {tab === "squads" && (
          <SquadsTab teams={teams} squads={squads} squadStats={squadStats} renameTeam={renameTeam}
            setTab={setTab} />
        )}
        {tab === "budgets" && (
          <BudgetsTab teams={teams} budgetStats={budgetStats} renameTeam={renameTeam} />
        )}
        {tab === "transfers" && (
          <TransfersTab teams={teams} squads={squads} transfers={transfers} logTransfer={logTransfer}
            logAdminReward={logAdminReward}
            setTransfers={setTransfers} auctions={auctions} createAuction={createAuction}
            placeBid={placeBid} finalizeAuction={finalizeAuction} respondToAuction={respondToAuction}
            deleteBid={deleteBid} editAuctionPlayerName={editAuctionPlayerName} nowTick={nowTick}
            myTeamId={myTeamId} playerDatabase={playerDatabase} />
        )}
        {tab === "fixtures" && (
          <FixturesTab teams={teams} fixtures={fixtures} setFixtures={setFixtures} logActivity={logActivity}
            myTeamId={myTeamId} squads={squads} />
        )}
        {tab === "standings" && (
          <StandingsTab teams={teams} standings={standings} />
        )}
        {tab === "prizes" && (
          <PrizesTab prizes={prizes} setPrizes={setPrizes} taxCollected={taxCollected} prizeTotal={prizeTotal}
            teams={teams} logActivity={logActivity} />
        )}
        {tab === "chat" && (
          <ChatTab chat={chat} setChat={setChat} teams={teams} myTeamId={myTeamId} markChatSeen={markChatSeen} />
        )}
        {tab === "rules" && (
          <RulesTab teams={teams} resetAll={resetAll} changeAdminPin={changeAdminPin}
            addFundsToTeam={addFundsToTeam} addEarned86Slot={addEarned86Slot}
            exportBackup={exportBackup} restoreBackup={restoreBackup} restoreFromNightlyBackup={restoreFromNightlyBackup}
            endSeason={endSeason} season={season} seasonHistory={seasonHistory} standings={standings}
            playerDatabase={playerDatabase} importPlayerDatabase={importPlayerDatabase}
            clearPlayerDatabase={clearPlayerDatabase} />
        )}
      </div>

      <div style={{ textAlign: "center", padding: "18px 18px 28px", color: C.muted, fontSize: 11.5 }}>
        Player data powered by{" "}
        <a href="https://cmtracker.net/" target="_blank" rel="noopener noreferrer" style={{ color: C.gold, textDecoration: "underline" }}>
          CMTracker.net
        </a>
      </div>

      {mentionToasts.length > 0 && (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 100, display: "grid", gap: 10, maxWidth: 320 }}>
          {mentionToasts.map((t) => (
            <div key={t.id} className="flex items-start gap-2" style={{
              background: "#0d1a2e", border: `1px solid ${C.gold}`, borderRadius: 8, padding: "12px 14px",
              boxShadow: "0 12px 32px rgba(0,0,0,0.5)", cursor: "pointer",
            }} onClick={() => { setTab("chat"); markChatSeen(); dismissToast(t.id); }}>
              <MessageCircle size={16} color={C.gold} style={{ marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ color: C.gold, fontWeight: 700, fontSize: 12.5 }}>{t.author} mentioned your team</div>
                <div style={{ color: C.text, fontSize: 12.5 }}>{t.text}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.muted, flexShrink: 0 }}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MyTeamPicker({ teams, myTeamId, chooseMyTeam, claimedTeams }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const mine = teams.find((t) => t.id === myTeamId);

  const pick = async (teamId) => {
    setErr("");
    const error = await chooseMyTeam(teamId);
    if (error) setErr(error);
    else setOpen(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2"
        style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 9, padding: "6px 12px", cursor: "pointer", color: mine ? C.gold : C.muted, fontSize: 12.5, fontWeight: 700 }}>
        <UserCircle2 size={15} />
        {mine ? mine.name : "Which team am I?"}
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8, zIndex: 30, minWidth: 200, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ color: C.muted, fontSize: 10.5, textTransform: "uppercase", padding: "4px 8px" }}>This device only — not shared</div>
          {teams.map((t) => {
            const takenByOther = claimedTeams[t.id] && t.id !== myTeamId;
            return (
              <button key={t.id} onClick={() => !takenByOther && pick(t.id)} disabled={takenByOther}
                className="flex items-center justify-between"
                style={{
                  width: "100%", textAlign: "left", background: t.id === myTeamId ? `${C.gold}22` : "transparent",
                  border: "none", borderRadius: 7, padding: "7px 8px", cursor: takenByOther ? "not-allowed" : "pointer",
                  color: takenByOther ? C.muted : (t.id === myTeamId ? C.gold : C.text), fontSize: 13,
                  opacity: takenByOther ? 0.55 : 1,
                }}>
                {t.name}
                {t.id === myTeamId && <Check size={13} />}
                {takenByOther && <span style={{ fontSize: 10.5, textTransform: "uppercase" }}>Taken</span>}
              </button>
            );
          })}
          {myTeamId && (
            <button onClick={() => { chooseMyTeam(null); setOpen(false); }}
              style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", borderRadius: 7, padding: "7px 8px", cursor: "pointer", color: C.muted, fontSize: 12 }}>
              Clear selection
            </button>
          )}
          {err && <div style={{ color: C.red, fontSize: 11.5, padding: "6px 8px" }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

function SaveIndicator({ state }) {
  if (state === "saving") return <span style={{ color: C.muted, fontSize: 12 }}>Saving…</span>;
  if (state === "saved") return (
    <span className="flex items-center gap-1" style={{ color: C.green, fontSize: 12 }}>
      <CheckCircle2 size={13} /> Saved
    </span>
  );
  return null;
}

function SyncIndicator({ syncState, lastSyncedAt, onRefresh }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const secsAgo = lastSyncedAt ? Math.round((Date.now() - lastSyncedAt) / 1000) : null;
  const label = secsAgo == null ? "—" : secsAgo < 5 ? "just now" : secsAgo < 60 ? `${secsAgo}s ago` : `${Math.round(secsAgo / 60)}m ago`;

  return (
    <button onClick={onRefresh} title="Check for other people's changes now"
      className="flex items-center gap-1.5"
      style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", color: C.muted, fontSize: 11.5 }}>
      <RotateCcw size={12} className={syncState === "checking" ? "animate-spin" : ""} />
      Synced {label}
    </button>
  );
}

/* ------------------------------- Dashboard -------------------------------- */
function HudStatChip({ label, value, tone }) {
  return (
    <div style={{ flex: 1, minWidth: 140, padding: "14px 18px", borderRight: `1px solid rgba(231,197,104,0.2)` }}>
      <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ color: tone === "gold" ? C.gold : "#fff", fontSize: 30, fontWeight: 600, fontVariantNumeric: "tabular-nums", textShadow: tone === "gold" ? `0 0 18px ${C.gold}55` : "none" }}>{value}</div>
    </div>
  );
}

function Dashboard({ teams, squads, standings, budgetStats, prizeTotal, taxCollected, events, setEvents, setTab, activity, myTeamId, season, clearActivity }) {
  const [newEvent, setNewEvent] = useState({ title: "", type: "League", date: "" });
  const leader = standings[0];
  const leaderTeam = teams.find((t) => t.id === leader?.id);
  const myTeam = myTeamId && teams.find((t) => t.id === myTeamId);
  const myStanding = myTeam && standings.find((s) => s.id === myTeamId);

  const addEvent = () => {
    if (!newEvent.title.trim()) return;
    setEvents((e) => [...e, { ...newEvent, id: uid() }]);
    setNewEvent({ title: "", type: "League", date: "" });
  };

  return (
    <div className="grid gap-4">
      {/* HUD stat strip — mirrors the top-right level/XP/currency bar from the reference */}
      <Panel style={{ padding: 0 }} accent={C.gold}>
          <div className="flex flex-wrap">
            <HudStatChip label="Teams" value={teams.length} />
            <HudStatChip label="Season" value={season} />
            <HudStatChip label="Tax Collected" value={money(taxCollected)} tone="gold" />
            <HudStatChip label="Prize Pool" value={money(prizeTotal)} tone="gold" />
          </div>
        </Panel>

        {myTeam && (
          <Panel accent={C.gold} style={{ padding: "26px 28px" }}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div style={{
                  width: 64, height: 64, borderRadius: 4,
                  background: `linear-gradient(135deg, ${C.gold}, ${C.goldDim})`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, color: "#0B1220", fontSize: 24,
                  boxShadow: `0 0 24px ${C.gold}66`,
                }} className="hud-font">
                  {myTeam.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="hud-font" style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" }}>Your Club</div>
                  <div className="hud-font" style={{ color: "#fff", fontWeight: 600, fontSize: 32, letterSpacing: "0.02em", lineHeight: 1.1 }}>{myTeam.name}</div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12.5 }}>{myTeam.manager}</div>
                </div>
              </div>
              {myStanding && (
                <div className="flex items-center gap-8">
                  <div style={{ textAlign: "center" }}>
                    <div className="hud-font" style={{ color: "rgba(255,255,255,0.5)", fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase" }}>Position</div>
                    <div className="hud-font" style={{ color: C.gold, fontWeight: 600, fontSize: 26, textShadow: `0 0 14px ${C.gold}55` }}>{myStanding.position}{myStanding.position === 1 ? "st" : myStanding.position === 2 ? "nd" : myStanding.position === 3 ? "rd" : "th"}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div className="hud-font" style={{ color: "rgba(255,255,255,0.5)", fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase" }}>Points</div>
                    <div className="hud-font" style={{ color: "#fff", fontWeight: 600, fontSize: 26 }}>{myStanding.points}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div className="hud-font" style={{ color: "rgba(255,255,255,0.5)", fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase" }}>Budget</div>
                    <div className="hud-font" style={{ color: "#fff", fontWeight: 600, fontSize: 26 }}>{money(budgetStats[myTeamId]?.current)}</div>
                  </div>
                  <Btn onClick={() => setTab("squads")}>View Squad</Btn>
                </div>
              )}
            </div>
          </Panel>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
          <Panel>
            <SectionTitle right={<Btn variant="ghost" size="sm" icon={ChevronRight} onClick={() => setTab("standings")}>Full Table</Btn>}>
              League Table — Top 5
            </SectionTitle>
            <Table
              head={["Pos", "Team", "Manager", "P", "GD", "Pts"]}
              rows={standings.slice(0, 5).map((r) => {
                const t = teams.find((x) => x.id === r.id);
                return [r.position, t?.name, t?.manager, r.played, r.gd, r.points];
              })}
            />
            {leader && (
              <div style={{ marginTop: 10, color: "rgba(255,255,255,0.6)", fontSize: 12.5 }}>
                Leading: <b style={{ color: C.gold }}>{leaderTeam?.name}</b> ({leaderTeam?.manager}) — {leader.points} pts
              </div>
            )}
          </Panel>

          <Panel>
            <SectionTitle>Next Events</SectionTitle>
            <div className="grid gap-2" style={{ marginBottom: 12 }}>
              {events.length === 0 && <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>No events added yet.</div>}
              {events.map((e) => (
                <div key={e.id} className="flex items-center justify-between" style={{ background: "rgba(255,255,255,0.04)", borderLeft: `2px solid ${C.gold}`, borderRadius: 4, padding: "8px 10px" }}>
                  <div>
                    <div style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>{e.title}</div>
                    <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11.5 }}>{e.type}{e.date ? ` · ${e.date}` : ""}</div>
                  </div>
                  <Btn variant="ghost" size="sm" icon={X} onClick={() => setEvents((ev) => ev.filter((x) => x.id !== e.id))} />
                </div>
              ))}
            </div>
            <div className="grid gap-2">
              <TextInput placeholder="Event title (e.g. Matchday 5 fixtures)" value={newEvent.title}
                onChange={(e) => setNewEvent((v) => ({ ...v, title: e.target.value }))} />
              <div className="flex gap-2">
                <Select value={newEvent.type} onChange={(e) => setNewEvent((v) => ({ ...v, type: e.target.value }))}>
                  {["League", "Transfer", "Cup", "Admin"].map((o) => <option key={o}>{o}</option>)}
                </Select>
                <TextInput type="date" value={newEvent.date} onChange={(e) => setNewEvent((v) => ({ ...v, date: e.target.value }))} />
              </div>
              <Btn icon={Plus} onClick={addEvent}>Add Event</Btn>
            </div>
          </Panel>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Panel>
            <SectionTitle>Find a Player</SectionTitle>
            <PlayerSearchInner teams={teams} squads={squads} />
          </Panel>
          <Panel>
            <ActivityTicker activity={activity} clearActivity={clearActivity} />
          </Panel>
        </div>

        <Panel>
          <SectionTitle>Budget Snapshot</SectionTitle>
          <Table
            head={["Team", "Manager", "Current Budget", "Wages", "Compliance"]}
            rows={teams.map((t) => {
              const b = budgetStats[t.id];
              return [t.name, t.manager, money(b.current), money(b.wages),
                <Pill tone={b.compliant ? "green" : "red"}>{b.compliant ? "OK" : "Over"}</Pill>];
            })}
          />
        </Panel>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <Panel style={{ padding: 16 }}>
      <Label>{label}</Label>
      <div style={{ color: tone === "gold" ? C.gold : C.text, fontSize: 22, fontWeight: 800 }}>{value}</div>
    </Panel>
  );
}

function MyTeamCard({ team, budgetStats, setTab }) {
  const b = budgetStats[team.id];
  return (
    <Panel style={{ padding: 16, border: `1px solid ${C.gold}55`, background: `linear-gradient(90deg, ${C.gold}14, transparent)` }}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <UserCircle2 size={18} color={C.gold} />
          <div>
            <div style={{ color: C.muted, fontSize: 11 }}>Your team</div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{team.name} <span style={{ color: C.muted, fontWeight: 400, fontSize: 12.5 }}>({team.manager})</span></div>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div style={{ fontSize: 13 }}><span style={{ color: C.muted }}>Budget: </span><b style={{ color: C.text }}>{money(b.current)}</b></div>
          <Pill tone={b.compliant ? "green" : "red"}>{b.compliant ? "Wages OK" : "Over wage cap"}</Pill>
          <Btn size="sm" variant="outline" icon={ChevronRight} onClick={() => setTab("squads")}>View squad</Btn>
        </div>
      </div>
    </Panel>
  );
}

function PlayerSearchInner({ teams, squads }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const t of teams) {
      const sq = squads[t.id];
      if (!sq) continue;
      [...sq.starters, ...sq.reserves].forEach((p) => {
        if (p && p.name.toLowerCase().includes(q)) out.push({ ...p, teamName: t.name });
      });
    }
    return out.slice(0, 20);
  }, [query, teams, squads]);

  return (
    <>
      <TextInput placeholder="Search every squad by player name…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div style={{ marginTop: 12 }}>
        {query.trim() === "" && <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12.5 }}>Handy before starting an auction — check who already owns a player.</div>}
        {query.trim() !== "" && results.length === 0 && <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12.5 }}>No players matching "{query}".</div>}
        {results.length > 0 && (
          <Table
            dense
            head={["Player", "Team", "Pos", "Rating"]}
            rows={results.map((p) => [p.name, p.teamName, p.position, p.rating])}
          />
        )}
      </div>
    </>
  );
}

function PlayerSearch({ teams, squads }) {
  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Search}>Find a Player</SectionTitle>
      <PlayerSearchInner teams={teams} squads={squads} />
    </Panel>
  );
}

function RecentActivityInner({ activity }) {
  const timeAgo = (t) => {
    const diff = Date.now() - t;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };
  return (
    <>
      {activity.length === 0 && <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12.5 }}>Nothing's happened yet — actions across the league will show up here.</div>}
      <div className="grid gap-2" style={{ maxHeight: 260, overflowY: "auto" }}>
        {activity.slice(0, 30).map((a) => (
          <div key={a.id} style={{ fontSize: 12.5, color: "#fff", borderBottom: "1px solid rgba(231,197,104,0.15)", paddingBottom: 6 }}>
            {a.text}
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10.5 }}>{timeAgo(a.time)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function RecentActivity({ activity }) {
  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={CalendarClock}>Recent Activity</SectionTitle>
      <RecentActivityInner activity={activity} />
    </Panel>
  );
}

function ActivityTicker({ activity, clearActivity }) {
  const [clearing, setClearing] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");

  const doClear = () => {
    const e = clearActivity(pin);
    if (e) setErr(e);
    else { setClearing(false); setPin(""); setErr(""); }
  };

  const items = activity.slice(0, 20);
  const tickerText = items.length > 0
    ? items.map((a) => a.text).join("     •     ")
    : "Nothing's happened yet — actions across the league will show up here.";
  const duration = Math.max(items.length * 6, 14);

  return (
    <>
      <SectionTitle right={
        <Btn size="sm" variant="ghost" icon={Trash2} onClick={() => setClearing((c) => !c)}>Clear</Btn>
      }>Recent Activity</SectionTitle>

      {clearing && (
        <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 10 }}>
          <TextInput type="password" placeholder="Admin PIN" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 120 }} />
          <Btn size="sm" variant="danger" onClick={doClear}>Clear all activity</Btn>
          {err && <span style={{ color: C.red, fontSize: 11.5 }}>{err}</span>}
        </div>
      )}

      <div style={{ overflow: "hidden", whiteSpace: "nowrap", borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: "12px 0" }}>
        <div style={{ display: "inline-block", paddingLeft: "100%", animation: `ticker-scroll ${duration}s linear infinite` }}>
          <span className="hud-font" style={{ color: C.text, fontSize: 14, letterSpacing: "0.02em" }}>{tickerText}</span>
        </div>
      </div>
    </>
  );
}

function Table({ head, rows, dense }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: dense ? 12.5 : 13.5 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{ textAlign: i === 1 ? "left" : "center", color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={head.length} style={{ color: C.muted, padding: "14px 8px", textAlign: "center" }}>Nothing here yet.</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? C.panelAlt : "transparent" }}>
              {r.map((cell, j) => (
                <td key={j} style={{ textAlign: j === 1 ? "left" : "center", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------- Squads ---------------------------------- */
function SquadsTab({ teams, squads, squadStats, renameTeam, setTab }) {
  const [activeTeam, setActiveTeam] = useState(teams[0].id);
  const team = teams.find((t) => t.id === activeTeam);
  const sq = squads[activeTeam];
  const stat = squadStats[activeTeam];

  return (
    <div className="grid gap-4">
      <Panel style={{ padding: 14 }}>
        <div className="flex gap-2 flex-wrap">
          {teams.map((t) => (
            <button key={t.id} onClick={() => setActiveTeam(t.id)}
              style={{
                padding: "6px 12px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontWeight: 700,
                border: `1px solid ${activeTeam === t.id ? C.gold : C.border}`,
                background: activeTeam === t.id ? `${C.gold}22` : "transparent",
                color: activeTeam === t.id ? C.gold : C.muted,
              }}>
              {t.name}
            </button>
          ))}
        </div>
      </Panel>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Users}
          right={<Btn size="sm" icon={Repeat} onClick={() => setTab("transfers")}>Add / release players via Transfers</Btn>}>
          {team.name} — {team.manager}
        </SectionTitle>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 16 }}>
          <Field label="Team name">
            <TextInput value={team.name} onChange={(e) => renameTeam(team.id, { name: e.target.value })} />
          </Field>
          <Field label="Manager">
            <TextInput value={team.manager} onChange={(e) => renameTeam(team.id, { manager: e.target.value })} />
          </Field>
          <Field label="Earned extra 86+ slots">
            <TextInput type="number" min={0} value={team.earned86}
              onChange={(e) => renameTeam(team.id, { earned86: Number(e.target.value) || 0 })} />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginBottom: 16 }}>
          <Pill tone="muted">{stat.filled}/26 registered</Pill>
          <Pill tone={stat.rated86 > (3 + (team.earned86 || 0)) ? "red" : "gold"}>
            {stat.rated86} × 86+ used (max {3 + (team.earned86 || 0)})
          </Pill>
          <Pill tone="muted">Squad value {money(stat.value)}</Pill>
          <Pill tone="muted">Wages {money(stat.wageM)}/season</Pill>
        </div>

        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 14, lineHeight: 1.6 }}>
          This list is read-only. Player details (name, position, rating, club, age, value, wage) are only entered
          once, on the Transfers tab — logging a transfer there adds the player here automatically, and releasing or
          selling them removes them from here too.
        </div>

        <SquadTable title={`Starting Squad (${STARTER_SLOTS} slots)`} players={sq.starters} labelForIdx={(i) => i + 1} />
        <div style={{ height: 18 }} />
        <SquadTable title={`Reserves (${RESERVE_SLOTS} slots)`} players={sq.reserves} labelForIdx={(i) => `R${i + 1}`} />
      </Panel>
    </div>
  );
}

function SquadTable({ title, players, labelForIdx }) {
  return (
    <div>
      <div style={{ color: C.gold, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 700 }}>
          <thead>
            <tr>
              {["#", "Player", "Pos", "Rating", "Club", "Age", "Value", "Wage (£k)"].map((h, i) => (
                <th key={i} style={{ color: C.muted, fontSize: 10.5, textTransform: "uppercase", padding: "5px 6px", textAlign: i === 1 ? "left" : "center", borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <SquadRow key={i} label={labelForIdx(i)} player={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SquadRow({ label, player }) {
  const filled = !!player;
  const cellPad = { padding: "6px 8px", borderBottom: `1px solid ${C.border}33` };
  const highlight = filled && Number(player.rating) >= 86 ? { background: `${C.gold}1a` } : {};
  const emptyStyle = { color: C.muted, fontStyle: "italic" };

  if (!filled) {
    return (
      <tr style={highlight}>
        <td style={{ ...cellPad, textAlign: "center", color: C.muted }}>{label}</td>
        <td colSpan={7} style={{ ...cellPad, ...emptyStyle }}>Empty slot</td>
      </tr>
    );
  }

  return (
    <tr style={highlight}>
      <td style={{ ...cellPad, textAlign: "center", color: C.muted }}>{label}</td>
      <td style={{ ...cellPad, color: C.text, fontWeight: 600 }}>{player.name}</td>
      <td style={{ ...cellPad, textAlign: "center", color: C.text }}>{player.position}</td>
      <td style={{ ...cellPad, textAlign: "center", color: C.text }}>{player.rating}</td>
      <td style={{ ...cellPad, color: C.text }}>{player.club}</td>
      <td style={{ ...cellPad, textAlign: "center", color: C.text }}>{player.age}</td>
      <td style={{ ...cellPad, textAlign: "center", color: C.text }}>{money(player.value)}</td>
      <td style={{ ...cellPad, textAlign: "center", color: C.text }}>{moneyK(player.wage)}</td>
    </tr>
  );
}

/* -------------------------------- Budgets ---------------------------------- */
function BudgetsTab({ teams, budgetStats }) {
  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Wallet}>Budgets & Wages</SectionTitle>
      <Table
        head={["Team", "Current Budget", "Remaining Wage Budget", "Tied Up in Live Bids", "Starting", "Spent", "Tax Paid", "Received", "Wages/Season", "Wage Cap", "Compliance"]}
        rows={teams.map((t) => {
          const b = budgetStats[t.id];
          const remainingWage = t.wageCap - b.wagesWithCommitted;
          const committedTotal = b.committedSpend + b.committedTax;
          return [
            t.name,
            <b style={{ color: b.current < 20 ? C.red : C.text }}>{money(b.current)}</b>,
            <b style={{ color: remainingWage < 0 ? C.red : C.text }}>{money(remainingWage)}</b>,
            committedTotal > 0
              ? <Pill tone="gold">{money(committedTotal)} + {moneyK(b.committedWage * 1000)}/wk</Pill>
              : <span style={{ color: C.muted }}>—</span>,
            money(t.budget), money(b.spent), money(b.tax), money(b.received),
            money(b.wages), money(t.wageCap),
            <Pill tone={b.compliant ? "green" : "red"}>{b.compliant ? "OK" : "Over"}</Pill>,
          ];
        })}
      />
      <div style={{ marginTop: 16, color: C.muted, fontSize: 12.5, lineHeight: 1.6 }}>
        Current Budget and Remaining Wage Budget already account for any auction a team is currently winning — the
        moment a team holds the top bid, that bid's cost (+10% tax) and the player's wage are reserved against their
        budget and wage cap, even before the 24h ratification completes. If they get outbid, the hold moves to
        whoever takes the lead instead. "Tied Up in Live Bids" shows that reserved amount on its own for clarity.
        Wages/Season and Spent/Received only reflect deals that have actually been ratified. Wage Cap is editable on
        the Squad Lists tab per team for Season 2+.
      </div>
    </Panel>
  );
}

/* ------------------------------- Transfers --------------------------------- */
function formatCountdown(ms) {
  if (ms <= 0) return "Ended";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h}h ${m}m left`;
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s left`;
}

function AuctionsPanel({ teams, squads, auctions, createAuction, placeBid, finalizeAuction, respondToAuction, deleteBid, editAuctionPlayerName, myTeamId, playerDatabase }) {
  const firstBidderFor = (sellerId) => {
    if (myTeamId && myTeamId !== sellerId) return myTeamId;
    return teams.find((t) => t.id !== sellerId)?.id || teams[0].id;
  };
  const blank = { seller: "FA", name: "", position: "ST", rating: 75, club: "", age: 25, wage: 0, minBid: 5, startingBidder: firstBidderFor("FA") };
  const [form, setForm] = useState(blank);
  const [warning, setWarning] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sellerSquadPlayers = form.seller !== "FA" ? [...(squads[form.seller]?.starters || []), ...(squads[form.seller]?.reserves || [])].filter(Boolean) : [];
  const pickSellerPlayer = (name) => {
    const pl = sellerSquadPlayers.find((p) => p.name === name);
    if (pl) setForm((f) => ({ ...f, name: pl.name, position: pl.position, rating: pl.rating, club: pl.club, age: pl.age, wage: pl.wage }));
  };

  const changeSeller = (sellerId) => {
    setForm((f) => ({
      ...f, seller: sellerId, name: "",
      startingBidder: f.startingBidder === sellerId ? firstBidderFor(sellerId) : f.startingBidder,
    }));
  };

  const startAuction = () => {
    const err = createAuction(form);
    if (err) { setWarning(err); return; }
    setWarning("");
    setForm({ ...blank, seller: form.seller, startingBidder: firstBidderFor(form.seller) });
  };

  const pending = auctions.filter((a) => a.status === "pending");
  const open = auctions.filter((a) => a.status === "open");
  const closed = auctions.filter((a) => a.status === "closed" || a.status === "declined");

  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Swords}>Player Auctions</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 16, lineHeight: 1.6 }}>
        Start an auction with an opening bid from one team, and others can bid it up in £250,000 steps. If the
        player belongs to another team, that team must accept the opening bid before the auction goes live and the
        24h clock starts — free agents skip this step. Every new highest bid resets the clock to a fresh 24 hours.
        Once the auction closes, the same ratification rules as any transfer apply: the seller is credited after
        12 hours, and the winner's signing (plus every losing bidder's tax charge) is ratified after 24 hours.
        Anyone can fix a typo in a player's name (the pencil icon) while an auction's still live or pending — that's
        not for renaming to a different player. Admins can remove a mistaken or joke bid from the history (PIN
        required), which recalculates who's currently winning.
      </div>

      <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Start a New Auction</div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          <Field label="Seller">
            <Select value={form.seller} onChange={(e) => changeSeller(e.target.value)}>
              <option value="FA">Non OCM</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Opening bidder">
            <Select value={form.startingBidder} onChange={(e) => setForm((f) => ({ ...f, startingBidder: e.target.value }))}>
              {teams.filter((t) => t.id !== form.seller).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Opening bid (£M)">
            <TextInput type="number" step="0.25" value={form.minBid} onChange={(e) => setForm((f) => ({ ...f, minBid: e.target.value }))} />
          </Field>
        </div>

        {form.seller !== "FA" ? (
          <div style={{ marginTop: 12 }}>
            <Field label="Player (from that team's current squad)">
              <Select value={form.name} onChange={(e) => pickSellerPlayer(e.target.value)}>
                <option value="">Select a player…</option>
                {sellerSquadPlayers.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.position}, {p.rating})</option>)}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", marginTop: 12 }}>
            <Field label="Player name">
              <PlayerAutocomplete
                value={form.name}
                onChange={(name) => setForm((f) => ({ ...f, name }))}
                playerDatabase={playerDatabase}
                onSelect={(p) => setForm((f) => ({
                  ...f, name: p.name, position: p.position || f.position, rating: p.rating || f.rating,
                  club: p.club || f.club, age: p.age || f.age, wage: p.wage || f.wage,
                  minBid: p.value ? roundUpTo250k(p.value) : f.minBid,
                }))}
              />
            </Field>
            <Field label="Position">
              <Select value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}>
                {POSITIONS.map((pos) => <option key={pos}>{pos}</option>)}
              </Select>
            </Field>
            <Field label="Rating"><TextInput type="number" value={form.rating} onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))} /></Field>
            <Field label="Club"><TextInput value={form.club} onChange={(e) => setForm((f) => ({ ...f, club: e.target.value }))} /></Field>
            <Field label="Age"><TextInput type="number" value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))} /></Field>
            <Field label="Weekly wage (£k)"><TextInput type="number" value={form.wage} onChange={(e) => setForm((f) => ({ ...f, wage: e.target.value }))} /></Field>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <Btn icon={Plus} onClick={startAuction}>
            {form.seller === "FA" ? "Start 24h auction" : "Propose bid to owning team"}
          </Btn>
        </div>
        {warning && <div className="flex items-center gap-2" style={{ marginTop: 10, color: C.red, fontSize: 12.5 }}><AlertTriangle size={14} /> {warning}</div>}
      </div>

      {pending.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ color: C.gold, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Awaiting Team Approval ({pending.length})</div>
          <div className="grid gap-3">
            {pending.map((a) => (
              <PendingAuctionCard key={a.id} auction={a} teams={teams} respondToAuction={respondToAuction} editAuctionPlayerName={editAuctionPlayerName} />
            ))}
          </div>
        </div>
      )}

      {open.length > 0 && (
        <div style={{ marginBottom: closed.length ? 20 : 0 }}>
          <div style={{ color: C.gold, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Live Auctions ({open.length})</div>
          <div className="grid gap-3">
            {open.map((a) => (
              <AuctionCard key={a.id} auction={a} teams={teams} now={now} placeBid={placeBid} finalizeAuction={finalizeAuction} deleteBid={deleteBid} editAuctionPlayerName={editAuctionPlayerName} myTeamId={myTeamId} />
            ))}
          </div>
        </div>
      )}
      {open.length === 0 && pending.length === 0 && <div style={{ color: C.muted, fontSize: 12.5 }}>No live auctions right now.</div>}

      {closed.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ color: C.muted, fontWeight: 700, fontSize: 12.5, marginBottom: 10 }}>Closed Auctions ({closed.length})</div>
          <Table
            dense
            head={["Player", "Seller", "Result", "Winning Bid"]}
            rows={closed.map((a) => [
              a.player.name,
              a.seller === "FA" ? "Non OCM" : teams.find((t) => t.id === a.seller)?.name || a.seller,
              a.status === "declined" ? "Declined by owner" : a.winner ? (teams.find((t) => t.id === a.winner)?.name || a.winner) : "No bids",
              a.status === "declined" ? "—" : a.winningBid ? money(a.winningBid) : "—",
            ])}
          />
        </div>
      )}
    </Panel>
  );
}

function PlayerNameEditor({ auction, editAuctionPlayerName, textStyle }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(auction.player.name);
  const [err, setErr] = useState("");

  if (!editing) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={textStyle}>{auction.player.name}</span>
        <button onClick={() => { setValue(auction.player.name); setEditing(true); setErr(""); }}
          title="Fix a spelling mistake in this name" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.muted }}>
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  const save = () => {
    const e = editAuctionPlayerName(auction.id, value);
    if (e) setErr(e); else setEditing(false);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <TextInput autoFocus value={value} onChange={(e) => setValue(e.target.value)}
        style={{ padding: "2px 6px", fontSize: 13, width: 160, display: "inline-block" }} />
      <button onClick={save} title="Save" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.green }}><Check size={14} /></button>
      <button onClick={() => setEditing(false)} title="Cancel" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.red }}><X size={14} /></button>
      {err && <span style={{ color: C.red, fontSize: 11 }}>{err}</span>}
    </span>
  );
}

function PendingAuctionCard({ auction, teams, respondToAuction, editAuctionPlayerName }) {
  const sellerName = teams.find((t) => t.id === auction.seller)?.name || auction.seller;
  const bidderName = teams.find((t) => t.id === auction.currentBidder)?.name || auction.currentBidder;
  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.gold}55`, borderRadius: 10, padding: 14 }}>
      <div className="flex items-center justify-between flex-wrap gap-2" style={{ marginBottom: 8 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>
            <PlayerNameEditor auction={auction} editAuctionPlayerName={editAuctionPlayerName} />
            <span style={{ color: C.muted, fontWeight: 400 }}> · {auction.player.position}, {auction.player.rating} OVR</span>
          </div>
          <div style={{ color: C.muted, fontSize: 11.5 }}>Owned by {sellerName}</div>
        </div>
        <Pill tone="gold">Awaiting {sellerName}'s decision</Pill>
      </div>
      <div style={{ fontSize: 13, marginBottom: 12 }}>
        <span style={{ color: C.muted }}>Opening bid: </span>
        <b style={{ color: C.text }}>{money(auction.currentBid)}</b>
        <span style={{ color: C.gold }}> from {bidderName}</span>
      </div>
      <div className="flex items-center gap-2">
        <Btn onClick={() => respondToAuction(auction.id, true)}>Accept — start 24h auction</Btn>
        <Btn variant="danger" onClick={() => respondToAuction(auction.id, false)}>Decline</Btn>
      </div>
    </div>
  );
}

function AuctionCard({ auction, teams, now, placeBid, finalizeAuction, deleteBid, editAuctionPlayerName, myTeamId }) {
  const [bidTeam, setBidTeam] = useState(
    (myTeamId && myTeamId !== auction.currentBidder) ? myTeamId : (teams.find((t) => t.id !== auction.currentBidder)?.id || teams[0].id)
  );
  const [bidAmount, setBidAmount] = useState("");
  const [err, setErr] = useState("");
  const [deletingBidId, setDeletingBidId] = useState(null);
  const [deletePin, setDeletePin] = useState("");
  const [deleteErr, setDeleteErr] = useState("");

  const remaining = auction.deadline - now;
  const ended = remaining <= 0;
  const requiredMin = auction.currentBid > 0 ? auction.currentBid + 0.25 : Math.max(auction.minBid, 0.25);
  const bidderCount = Object.keys(auction.bidsByTeam).length;

  const submitBid = () => {
    const e = placeBid(auction.id, bidTeam, bidAmount || requiredMin);
    if (e) setErr(e); else { setErr(""); setBidAmount(""); }
  };

  const confirmDeleteBid = () => {
    const e = deleteBid(auction.id, deletingBidId, deletePin);
    if (e) setDeleteErr(e);
    else { setDeletingBidId(null); setDeletePin(""); setDeleteErr(""); }
  };

  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div className="flex items-center justify-between flex-wrap gap-2" style={{ marginBottom: 8 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>
            <PlayerNameEditor auction={auction} editAuctionPlayerName={editAuctionPlayerName} />
            <span style={{ color: C.muted, fontWeight: 400 }}> · {auction.player.position}, {auction.player.rating} OVR</span>
          </div>
          <div style={{ color: C.muted, fontSize: 11.5 }}>
            {auction.player.club}{auction.player.club ? " · " : ""}Selling: {auction.seller === "FA" ? "Non OCM" : teams.find((t) => t.id === auction.seller)?.name}
          </div>
        </div>
        <Pill tone={ended ? "red" : "gold"}>{formatCountdown(remaining)}</Pill>
      </div>

      <div className="flex items-center gap-4 flex-wrap" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ color: C.muted }}>Current bid: </span>
          <b style={{ color: C.text }}>{auction.currentBid > 0 ? money(auction.currentBid) : "No bids yet"}</b>
          {auction.currentBidder && (
            <span style={{ color: C.gold }}> — {teams.find((t) => t.id === auction.currentBidder)?.name}</span>
          )}
        </div>
        <Pill tone="muted">{bidderCount} team{bidderCount === 1 ? "" : "s"} bidding</Pill>
      </div>

      {!ended ? (
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="Bidding team">
            <Select value={bidTeam} onChange={(e) => setBidTeam(e.target.value)}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label={`Bid (£M) — min ${money(requiredMin)}`}>
            <TextInput type="number" step="0.25" placeholder={String(requiredMin)} value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} />
          </Field>
          <Btn onClick={submitBid}>Place bid</Btn>
        </div>
      ) : (
        <Btn variant="danger" onClick={() => finalizeAuction(auction.id)}>Finalize auction</Btn>
      )}
      {err && <div className="flex items-center gap-2" style={{ marginTop: 8, color: C.red, fontSize: 12 }}><AlertTriangle size={13} /> {err}</div>}

      {auction.history.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>Bid history (admin can remove a mistaken bid):</div>
          <div className="grid gap-1">
            {auction.history.map((h) => (
              <div key={h.id} className="flex items-center justify-between" style={{ fontSize: 11.5, color: C.muted }}>
                <span>{teams.find((t) => t.id === h.team)?.name} — {money(h.amount)}</span>
                <button onClick={() => { setDeletingBidId(h.id); setDeletePin(""); setDeleteErr(""); }}
                  title="Remove this bid (admin)" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.red }}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          {deletingBidId && (
            <div className="flex items-end gap-2 flex-wrap" style={{ marginTop: 8, background: C.panel, borderRadius: 8, padding: 10 }}>
              <Field label="Admin PIN to remove this bid">
                <TextInput type="password" value={deletePin} onChange={(e) => setDeletePin(e.target.value)} style={{ width: 140 }} />
              </Field>
              <Btn variant="danger" size="sm" onClick={confirmDeleteBid}>Remove bid</Btn>
              <Btn variant="outline" size="sm" onClick={() => setDeletingBidId(null)}>Cancel</Btn>
              {deleteErr && <span style={{ color: C.red, fontSize: 11.5 }}>{deleteErr}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TransfersTab({ teams, squads, transfers, logTransfer, logAdminReward, setTransfers, auctions, createAuction, placeBid, finalizeAuction, respondToAuction, deleteBid, editAuctionPlayerName, nowTick, myTeamId, playerDatabase }) {
  const blank = { date: todayISO(), from: "FA", to: myTeamId || teams[0].id, name: "", position: "ST", rating: 75, club: "", age: 25, wage: 0, price: 0, notes: "" };
  const [form, setForm] = useState(blank);
  const [warning, setWarning] = useState("");
  const [pin, setPin] = useState("");

  const sellerSquadPlayers = form.from !== "FA" ? [...(squads[form.from]?.starters || []), ...(squads[form.from]?.reserves || [])].filter(Boolean) : [];

  const pickSellerPlayer = (name) => {
    const pl = sellerSquadPlayers.find((p) => p.name === name);
    if (pl) setForm((f) => ({ ...f, name: pl.name, position: pl.position, rating: pl.rating, club: pl.club, age: pl.age, wage: pl.wage }));
  };

  const tax = form.price > 0 ? Math.max(Number(form.price) * 0.1, 0.25) : 0;

  const submit = () => {
    const msg = logAdminReward(pin, form);
    setWarning(msg || "");
    if (!msg) setForm({ ...blank, to: form.to });
  };

  return (
    <div className="grid gap-4">
      <AuctionsPanel teams={teams} squads={squads} auctions={auctions} createAuction={createAuction}
        placeBid={placeBid} finalizeAuction={finalizeAuction} respondToAuction={respondToAuction}
        deleteBid={deleteBid} editAuctionPlayerName={editAuctionPlayerName} myTeamId={myTeamId}
        playerDatabase={playerDatabase} />

      <Panel style={{ padding: 18, border: `1px solid ${C.gold}55` }}>
        <SectionTitle icon={Lock}>Admin: Player Rewards</SectionTitle>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 12 }}>
          For giving a player to a team outside the normal bidding process — season rewards, prizes, corrections,
          or anything with no competing bids. Requires the admin PIN. If multiple teams might compete for a player,
          use Player Auctions above instead.
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <Field label="Date">
            <TextInput type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </Field>
          <Field label="From (seller)">
            <Select value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value, name: "" }))}>
              <option value="FA">Non OCM</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="To (buyer)">
            <Select value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="FA">Non OCM (release)</option>
            </Select>
          </Field>
          <Field label="Bid (£M)">
            <TextInput type="number" step="0.25" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
          </Field>
        </div>

        {form.from !== "FA" ? (
          <div style={{ marginTop: 12 }}>
            <Field label="Player (from that team's current squad)">
              <Select value={form.name} onChange={(e) => pickSellerPlayer(e.target.value)}>
                <option value="">Select a player…</option>
                {sellerSquadPlayers.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.position}, {p.rating})</option>)}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 12 }}>
            <Field label="Player name">
              <PlayerAutocomplete
                value={form.name}
                onChange={(name) => setForm((f) => ({ ...f, name }))}
                playerDatabase={playerDatabase}
                onSelect={(p) => setForm((f) => ({
                  ...f, name: p.name, position: p.position || f.position, rating: p.rating || f.rating,
                  club: p.club || f.club, age: p.age || f.age, wage: p.wage || f.wage,
                  price: p.value ? roundUpTo250k(p.value) : f.price,
                }))}
              />
            </Field>
            <Field label="Position">
              <Select value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}>
                {POSITIONS.map((pos) => <option key={pos}>{pos}</option>)}
              </Select>
            </Field>
            <Field label="Rating"><TextInput type="number" value={form.rating} onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))} /></Field>
            <Field label="Club"><TextInput value={form.club} onChange={(e) => setForm((f) => ({ ...f, club: e.target.value }))} /></Field>
            <Field label="Age"><TextInput type="number" value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))} /></Field>
            <Field label="Weekly wage (£k)"><TextInput type="number" value={form.wage} onChange={(e) => setForm((f) => ({ ...f, wage: e.target.value }))} /></Field>
          </div>
        )}

        <div className="flex items-end gap-4 flex-wrap" style={{ marginTop: 14 }}>
          <Pill tone="gold">Tax: {money(tax)}</Pill>
          <Pill tone="muted">Final cost to buyer: {money(Number(form.price || 0) + tax)}</Pill>
          <Field label="Admin PIN">
            <TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 140 }} />
          </Field>
          <Btn icon={Plus} onClick={submit}>Give player</Btn>
        </div>
        {warning && (
          <div className="flex items-center gap-2" style={{ marginTop: 10, color: C.red, fontSize: 12.5 }}>
            <AlertTriangle size={14} /> {warning}
          </div>
        )}
        <div style={{ marginTop: 10, color: C.muted, fontSize: 11.5 }}>
          Bids should be in £250,000 increments. Tax is 10% of the bid (minimum £0.25M), charged to the buyer.
          Logging a transfer doesn't move anything immediately — the seller is credited and loses the player after
          12 hours, and the buyer's signing (squad placement, budget hit, tax) is ratified after the full 24 hours.
          See the Status column in Transfer History below for where each deal stands.
        </div>
      </Panel>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Repeat}>Transfer History</SectionTitle>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 12, lineHeight: 1.6 }}>
          Every deal is ratified in two stages: the selling side is settled after 12 hours (budget credited, player
          leaves their squad); the buying side — the actual signing, squad placement, budget hit and tax — only
          becomes official after the full 24 hours.
        </div>
        <Table
          dense
          head={["Date", "Player", "From", "To", "Bid", "Tax", "Final Cost", "Status", ""]}
          rows={transfers.map((tx) => {
            const st = transferStatus(tx, nowTick);
            return [
              tx.date, tx.player,
              tx.from === "FA" ? "Non OCM" : tx.from === "AUCTION_LOSS" ? "— (losing bid)" : teams.find((t) => t.id === tx.from)?.name || tx.from,
              tx.to === "FA" ? "Non OCM" : teams.find((t) => t.id === tx.to)?.name || tx.to,
              money(tx.price), money(tx.tax), money(tx.finalCost),
              <Pill tone={st.tone}>{st.label}</Pill>,
              <button onClick={() => setTransfers((all) => all.filter((x) => x.id !== tx.id))} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.red }}>
                <Trash2 size={14} />
              </button>,
            ];
          })}
        />
      </Panel>
    </div>
  );
}

/* -------------------------------- Fixtures ---------------------------------- */
function MatchStatsPanel({ team1Name, team2Name, team1Players, team2Players, resultForm, togglePlayed, updateStat, setMotm, error }) {
  const playedList = (side, players) => players.filter((p) => resultForm[side][p.name]?.played);
  const motmOptions = [
    ...playedList("team1Stats", team1Players).map((p) => ({ name: p.name, team: team1Name })),
    ...playedList("team2Stats", team2Players).map((p) => ({ name: p.name, team: team2Name })),
  ];

  const TeamStatBlock = ({ side, teamName, players }) => (
    <div>
      <div style={{ color: C.gold, fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>{teamName}</div>
      <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, background: C.panel }}>
              {["Played", "Player", "G", "A", "Y", "R"].map((h, i) => (
                <th key={i} style={{ padding: "4px 6px", color: C.muted, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const s = resultForm[side][p.name];
              return (
                <tr key={p.name}>
                  <td style={{ textAlign: "center", padding: "3px 6px" }}>
                    <input type="checkbox" checked={s.played} onChange={() => togglePlayed(side, p.name)} />
                  </td>
                  <td style={{ padding: "3px 6px", color: s.played ? C.text : C.muted }}>{p.name}</td>
                  <td style={{ padding: "2px" }}>
                    <input type="number" min={0} disabled={!s.played} value={s.goals}
                      onChange={(e) => updateStat(side, p.name, "goals", Number(e.target.value) || 0)}
                      style={{ width: 34, background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 4px", textAlign: "center" }} />
                  </td>
                  <td style={{ padding: "2px" }}>
                    <input type="number" min={0} disabled={!s.played} value={s.assists}
                      onChange={(e) => updateStat(side, p.name, "assists", Number(e.target.value) || 0)}
                      style={{ width: 34, background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 4px", textAlign: "center" }} />
                  </td>
                  <td style={{ textAlign: "center", padding: "2px" }}>
                    <input type="checkbox" disabled={!s.played} checked={s.yellow} onChange={(e) => updateStat(side, p.name, "yellow", e.target.checked)} />
                  </td>
                  <td style={{ textAlign: "center", padding: "2px" }}>
                    <input type="checkbox" disabled={!s.played} checked={s.red} onChange={(e) => updateStat(side, p.name, "red", e.target.checked)} />
                  </td>
                </tr>
              );
            })}
            {players.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 10, color: C.muted, textAlign: "center" }}>No players in this squad yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.gold}55`, borderRadius: 10, padding: 14, marginTop: 6 }}>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Match Stats — required before saving</div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <TeamStatBlock side="team1Stats" teamName={team1Name} players={team1Players} />
        <TeamStatBlock side="team2Stats" teamName={team2Name} players={team2Players} />
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Man of the Match">
          <Select value={resultForm.motm} onChange={(e) => setMotm(e.target.value)} style={{ maxWidth: 260 }}>
            <option value="">Select a player who played…</option>
            {motmOptions.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.team})</option>)}
          </Select>
        </Field>
      </div>
      {error && <div className="flex items-center gap-2" style={{ marginTop: 10, color: C.red, fontSize: 12 }}><AlertTriangle size={13} /> {error}</div>}
    </div>
  );
}

function FixturesTab({ teams, fixtures, setFixtures, logActivity, myTeamId, squads }) {
  const blank = { matchday: 1, team1: myTeamId || teams[0].id, team2: teams.find((t) => t.id !== myTeamId)?.id || teams[1].id, date: todayISO(), proof: "" };
  const [form, setForm] = useState(blank);
  const [warning, setWarning] = useState("");
  const [uploadingId, setUploadingId] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [viewingFixture, setViewingFixture] = useState(null); // fixture object or null
  const [enteringResultFor, setEnteringResultFor] = useState(null); // fixture id
  const [resultForm, setResultForm] = useState(null); // { score1, score2, team1Stats, team2Stats, motm }
  const [resultError, setResultError] = useState("");

  const add = () => {
    if (form.team1 === form.team2) { setWarning("Team 1 and Team 2 can't be the same."); return; }
    setFixtures((f) => [{ ...form, score1: "", score2: "", id: uid(), hasProofImage: false }, ...f]);
    setWarning("");
    setForm({ ...blank, matchday: Number(form.matchday) + 0 });
  };

  const squadPlayersFor = (teamId) => [...(squads[teamId]?.starters || []), ...(squads[teamId]?.reserves || [])].filter(Boolean);

  const startResult = (f) => {
    setEnteringResultFor(f.id);
    setResultError("");
    const blankPlayerStats = (teamId) => Object.fromEntries(
      squadPlayersFor(teamId).map((p) => [p.name, { played: false, goals: 0, assists: 0, yellow: false, red: false }])
    );
    setResultForm({
      score1: "", score2: "",
      team1Stats: blankPlayerStats(f.team1),
      team2Stats: blankPlayerStats(f.team2),
      motm: "",
    });
  };

  const togglePlayed = (side, playerName) => {
    setResultForm((rf) => ({
      ...rf,
      [side]: { ...rf[side], [playerName]: { ...rf[side][playerName], played: !rf[side][playerName].played } },
    }));
  };

  const updateStat = (side, playerName, field, value) => {
    setResultForm((rf) => ({
      ...rf,
      [side]: { ...rf[side], [playerName]: { ...rf[side][playerName], [field]: value } },
    }));
  };

  const saveResult = (f) => {
    if (resultForm.score1 === "" || resultForm.score2 === "") { setResultError("Enter both scores."); return; }
    const team1Played = Object.entries(resultForm.team1Stats).filter(([, s]) => s.played);
    const team2Played = Object.entries(resultForm.team2Stats).filter(([, s]) => s.played);
    if (team1Played.length === 0 || team2Played.length === 0) {
      setResultError("Select at least one player who played for each team before saving.");
      return;
    }
    const stats = {
      team1: team1Played.map(([name, s]) => ({ name, ...s })),
      team2: team2Played.map(([name, s]) => ({ name, ...s })),
      motm: resultForm.motm || null,
    };
    setFixtures((all) => all.map((x) => (x.id === f.id ? { ...x, score1: resultForm.score1, score2: resultForm.score2, stats } : x)));
    const t1 = teams.find((t) => t.id === f.team1)?.name, t2 = teams.find((t) => t.id === f.team2)?.name;
    logActivity(`Result: ${t1} ${resultForm.score1} – ${resultForm.score2} ${t2} (Matchday ${f.matchday})`, "fixture");
    setEnteringResultFor(null);
    setResultForm(null);
  };

  const removeFixture = async (f) => {
    if (f.hasProofImage) {
      try { await storage.delete(PROOF_KEY(f.id), true); } catch (e) { /* already gone, fine */ }
    }
    setFixtures((all) => all.filter((x) => x.id !== f.id));
  };

  const uploadProof = async (fixtureId, file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setUploadError("Please choose an image file."); return; }
    setUploadError(null);
    setUploadingId(fixtureId);
    try {
      const dataUrl = await compressImageFile(file);
      const res = await storage.set(PROOF_KEY(fixtureId), dataUrl, true);
      if (!res) throw new Error("Save failed");
      setFixtures((all) => all.map((f) => (f.id === fixtureId ? { ...f, hasProofImage: true } : f)));
    } catch (e) {
      setUploadError("Couldn't save that photo — try a smaller image.");
    } finally {
      setUploadingId(null);
    }
  };

  return (
    <div className="grid gap-4">
      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Swords}>Post a Fixture</SectionTitle>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 12 }}>
          Post the fixture first — add the score afterward once the match has actually been played,
          using "Add Result" in the list below.
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          <Field label="Matchday"><TextInput type="number" min={1} value={form.matchday} onChange={(e) => setForm((f) => ({ ...f, matchday: e.target.value }))} /></Field>
          <Field label="Team 1">
            <Select value={form.team1} onChange={(e) => setForm((f) => ({ ...f, team1: e.target.value }))}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Team 2">
            <Select value={form.team2} onChange={(e) => setForm((f) => ({ ...f, team2: e.target.value }))}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Date"><TextInput type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn icon={Plus} onClick={add}>Post fixture</Btn>
        </div>
        {warning && <div className="flex items-center gap-2" style={{ marginTop: 10, color: C.red, fontSize: 12.5 }}><AlertTriangle size={14} /> {warning}</div>}
        <div style={{ marginTop: 10, color: C.muted, fontSize: 11.5 }}>
          You can attach a proof photo (end-of-match screenshot) to each fixture once it's added — look for the
          camera icon next to it in the list below.
        </div>
      </Panel>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Swords}>Fixture List</SectionTitle>
        {uploadError && (
          <div className="flex items-center gap-2" style={{ marginBottom: 10, color: C.red, fontSize: 12.5 }}>
            <AlertTriangle size={14} /> {uploadError}
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {["MD", "Team 1", "Score", "Team 2", "Date", "Proof notes", "Photo", ""].map((h, i) => (
                  <th key={i} style={{ textAlign: i === 1 || i === 3 ? "left" : "center", color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixtures.length === 0 && (
                <tr><td colSpan={8} style={{ color: C.muted, padding: "14px 8px", textAlign: "center" }}>No fixtures yet.</td></tr>
              )}
              {fixtures.map((f, i) => {
                const t1 = teams.find((t) => t.id === f.team1)?.name || f.team1;
                const t2 = teams.find((t) => t.id === f.team2)?.name || f.team2;
                const played = f.score1 !== "" && f.score2 !== "" && f.score1 != null && f.score2 != null;
                const uploading = uploadingId === f.id;
                const enteringResult = enteringResultFor === f.id;
                return (
                  <Fragment key={f.id}>
                  <tr style={{ background: i % 2 ? C.panelAlt : "transparent" }}>
                    <td style={{ textAlign: "center", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>{f.matchday}</td>
                    <td style={{ textAlign: "left", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>{t1}</td>
                    <td style={{ textAlign: "center", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>
                      {enteringResult ? (
                        <div className="flex items-center justify-center gap-1">
                          <TextInput type="number" min={0} value={resultForm.score1}
                            onChange={(e) => setResultForm((r) => ({ ...r, score1: e.target.value }))}
                            style={{ width: 46, padding: "3px 4px", textAlign: "center" }} />
                          <span>–</span>
                          <TextInput type="number" min={0} value={resultForm.score2}
                            onChange={(e) => setResultForm((r) => ({ ...r, score2: e.target.value }))}
                            style={{ width: 46, padding: "3px 4px", textAlign: "center" }} />
                        </div>
                      ) : played ? `${f.score1} – ${f.score2}` : "Pending"}
                    </td>
                    <td style={{ textAlign: "left", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>{t2}</td>
                    <td style={{ textAlign: "center", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>{f.date}</td>
                    <td style={{ textAlign: "center", color: C.text, padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>{f.proof || "—"}</td>
                    <td style={{ textAlign: "center", padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>
                      {f.hasProofImage ? (
                        <button onClick={() => setViewingFixture(f)} title="View proof photo"
                          style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", cursor: "pointer", color: C.gold, display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Eye size={13} /> View
                        </button>
                      ) : uploading ? (
                        <span style={{ color: C.muted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Loader2 size={13} className="animate-spin" /> Uploading…
                        </span>
                      ) : (
                        <label style={{ cursor: "pointer", color: C.muted, display: "inline-flex", alignItems: "center", gap: 4, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px" }}>
                          <Upload size={13} /> Upload
                          <input type="file" accept="image/*" style={{ display: "none" }}
                            onChange={(e) => uploadProof(f.id, e.target.files?.[0])} />
                        </label>
                      )}
                    </td>
                    <td style={{ textAlign: "center", padding: "7px 8px", borderBottom: `1px solid ${C.border}33` }}>
                      <div className="flex items-center justify-center gap-2">
                        {enteringResult ? (
                          <>
                            <button onClick={() => saveResult(f)} title="Save result" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.green }}><Check size={15} /></button>
                            <button onClick={() => { setEnteringResultFor(null); setResultForm(null); }} title="Cancel" style={{ background: "transparent", border: "none", cursor: "pointer", color: C.muted }}><X size={15} /></button>
                          </>
                        ) : !played ? (
                          <Btn size="sm" variant="outline" onClick={() => startResult(f)}>Add Result</Btn>
                        ) : f.stats ? (
                          <Pill tone="gold">Stats logged</Pill>
                        ) : null}
                        <button onClick={() => removeFixture(f)} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.red }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {enteringResult && (
                    <tr>
                      <td colSpan={8} style={{ padding: "0 8px 14px" }}>
                        <MatchStatsPanel
                          team1Name={t1} team2Name={t2}
                          team1Players={squadPlayersFor(f.team1)} team2Players={squadPlayersFor(f.team2)}
                          resultForm={resultForm} togglePlayed={togglePlayed} updateStat={updateStat}
                          setMotm={(name) => setResultForm((r) => ({ ...r, motm: name }))}
                          error={resultError}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {viewingFixture && (
        <ProofModal fixture={viewingFixture} teams={teams} onClose={() => setViewingFixture(null)} />
      )}
    </div>
  );
}

function ProofModal({ fixture, teams, onClose }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  const t1 = teams.find((t) => t.id === fixture.team1)?.name || fixture.team1;
  const t2 = teams.find((t) => t.id === fixture.team2)?.name || fixture.team2;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await storage.get(PROOF_KEY(fixture.id), true);
        if (!cancelled) {
          if (res && res.value) setSrc(res.value);
          else setError("No photo found — it may have been removed.");
        }
      } catch (e) {
        if (!cancelled) setError("Couldn't load that photo.");
      }
    })();
    return () => { cancelled = true; };
  }, [fixture.id]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, maxWidth: 640, width: "100%", maxHeight: "85vh", overflow: "auto" }}>
        <div className="flex items-center justify-between" style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13.5 }}>{t1} vs {t2} — Matchday {fixture.matchday} proof</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.muted }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 16 }}>
          {!src && !error && (
            <div className="flex items-center gap-2" style={{ color: C.muted, fontSize: 13 }}>
              <Loader2 size={16} className="animate-spin" /> Loading photo…
            </div>
          )}
          {error && <div style={{ color: C.red, fontSize: 13 }}>{error}</div>}
          {src && <img src={src} alt="Match result proof" style={{ width: "100%", borderRadius: 8, display: "block" }} />}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Standings ---------------------------------- */
function StandingsTab({ teams, standings }) {
  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Trophy}>Standings</SectionTitle>
      <Table
        head={["Pos", "Team", "Manager", "P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Next Season Cap"]}
        rows={standings.map((r) => {
          const t = teams.find((x) => x.id === r.id);
          return [
            r.position === 1 ? <Pill tone="gold">1</Pill> : r.position, t?.name, t?.manager,
            r.played, r.w, r.d, r.l, r.gf, r.ga, r.gd, <b>{r.points}</b>, money(r.nextCap),
          ];
        })}
      />
    </Panel>
  );
}

/* -------------------------------- Prize Pool ---------------------------------- */
function PrizesTab({ prizes, setPrizes, taxCollected, prizeTotal, teams, logActivity }) {
  const blank = { category: "", description: "", amount: 0, recipient: "", date: todayISO() };
  const [form, setForm] = useState(blank);

  const add = () => {
    if (!form.category.trim()) return;
    setPrizes((p) => [...p, { ...form, id: uid() }]);
    setForm(blank);
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))" }}>
        <StatCard label="Tax Collected (auto)" value={money(taxCollected)} tone="gold" />
        <StatCard label="Total Prize Pool" value={money(prizeTotal)} tone="gold" />
      </div>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Coins}>Add Prize / Bonus</SectionTitle>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <Field label="Category"><TextInput value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="e.g. League Winner" /></Field>
          <Field label="Description"><TextInput value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
          <Field label="Amount (£M)"><TextInput type="number" step="0.1" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
          <Field label="Recipient">
            <Select value={form.recipient} onChange={(e) => setForm((f) => ({ ...f, recipient: e.target.value }))}>
              <option value="">TBD</option>
              {teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        <div style={{ marginTop: 14 }}><Btn icon={Plus} onClick={add}>Add</Btn></div>
      </Panel>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Coins}>Prize Log</SectionTitle>
        <Table
          head={["Category", "Description", "Amount", "Recipient", "Date", ""]}
          rows={prizes.map((p) => [
            p.category, p.description, money(p.amount), p.recipient || "TBD", p.date,
            <button onClick={() => setPrizes((all) => all.filter((x) => x.id !== p.id))} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.red }}>
              <Trash2 size={14} />
            </button>,
          ])}
        />
      </Panel>
    </div>
  );
}

/* --------------------------------- Chat ---------------------------------- */
function ChatTab({ chat, setChat, teams, myTeamId, markChatSeen }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [tagTeam, setTagTeam] = useState("");
  const mine = teams.find((t) => t.id === myTeamId);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat.length]);

  // Mark seen whenever this tab is open and a new message arrives, not just on nav-click.
  useEffect(() => {
    markChatSeen();
  }, [chat.length, markChatSeen]);

  const send = () => {
    if (!text.trim()) return;
    const author = mine ? mine.name : (name.trim() || "Anonymous");
    setChat((c) => [...c, { id: uid(), author, text: text.trim(), time: Date.now(), taggedTeam: tagTeam || null }]);
    setText("");
    setTagTeam("");
  };

  const timeStr = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={MessageCircle}>League Chat</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 14 }}>
        Shared with everyone using this app — good for bidding chatter, banter, or quick announcements without
        leaving the page. {!mine && "Pick your team (top right) and it'll sign your messages automatically."}
        {" "}Tag a team to flash a notification for whoever's on it.
      </div>

      <div style={{
        background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12,
        maxHeight: 420, overflowY: "auto", marginBottom: 14,
      }}>
        {chat.length === 0 && <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 20 }}>No messages yet — say something!</div>}
        <div className="grid gap-3">
          {chat.map((m) => (
            <div key={m.id}>
              <div className="flex items-baseline gap-2">
                <span style={{ color: C.gold, fontWeight: 700, fontSize: 12.5 }}>{m.author}</span>
                {m.taggedTeam && (
                  <span style={{ background: `${C.gold}22`, color: C.gold, borderRadius: 999, padding: "1px 8px", fontSize: 10.5, fontWeight: 700 }}>
                    @{teams.find((t) => t.id === m.taggedTeam)?.name || "team"}
                  </span>
                )}
                <span style={{ color: C.muted, fontSize: 10.5 }}>{timeStr(m.time)}</span>
              </div>
              <div style={{ color: C.text, fontSize: 13.5 }}>{m.text}</div>
            </div>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        {!mine && (
          <Field label="Your name">
            <TextInput placeholder="e.g. Alex" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
          </Field>
        )}
        <Field label="Tag a team (optional)">
          <Select value={tagTeam} onChange={(e) => setTagTeam(e.target.value)} style={{ width: 150 }}>
            <option value="">No tag</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label={mine ? `Message (as ${mine.name})` : "Message"}>
          <TextInput placeholder="Type a message…" value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            style={{ width: 300 }} />
        </Field>
        <Btn icon={Send} onClick={send}>Send</Btn>
      </div>
    </Panel>
  );
}

/* --------------------------------- Rules ---------------------------------- */
function RulesTab({ teams, resetAll, changeAdminPin, addFundsToTeam, addEarned86Slot, exportBackup, restoreBackup, restoreFromNightlyBackup, endSeason, season, seasonHistory, standings, playerDatabase, importPlayerDatabase, clearPlayerDatabase }) {
  const n = teams.length;
  return (
    <div className="grid gap-4">
      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={BookOpen}>League Rules</SectionTitle>
        <div className="grid gap-3" style={{ color: C.text, fontSize: 13.5, lineHeight: 1.7 }}>
          <RuleBlock title="Currency & Budget">
            All values in £. Every team starts Season 1 with £500,000,000. From Season 2 onward, leftover budget
            carries over and each team gets a position-based top-up when the season ends (see End of Season below).
            Bids must be placed in £250,000 increments.
          </RuleBlock>
          <RuleBlock title="Transfer Tax">
            10% tax on the winning bid, minimum £250,000 per bidder. All tax collected feeds the Prize Pool automatically.
          </RuleBlock>
          <RuleBlock title="Squad Rules">
            21 starting slots + 5 reserve slots (26 max). Max 3 players rated 86+ initially. Extra 86+ slots are earned
            via wins and awarded every new season — tradable with a minimum value of £50,000,000.
          </RuleBlock>
          <RuleBlock title="Salary / Wage System">
            Wages based on Sofifa (or CM Tracker if £0), deducted once per season. Base wage cap £2,000,000. From
            Season 2, the cap scales by final position in £250,000 steps — champion gets £3,750,000, decreasing by
            £250,000 per position down the table, down to £1,500,000 for last place.
          </RuleBlock>
          <RuleBlock title="Fixtures & Proof">
            Matches are played as Online Friendlies. Every result needs proof (screenshot/video) within 24 hours.
          </RuleBlock>
          <RuleBlock title="Scoring">Win = 3 pts, Draw = 1 pt each, Loss = 0 pts. Tiebreak: Points → GD → GF → Head-to-head.</RuleBlock>
        </div>
      </Panel>

      <Panel style={{ padding: 18 }}>
        <SectionTitle icon={Trophy}>Season 2+ Wage Cap by Finishing Position</SectionTitle>
        <Table
          head={["Position", "Wage Cap"]}
          rows={Array.from({ length: n }, (_, i) => [
            `${i + 1}${i === 0 ? "st" : i === 1 ? "nd" : i === 2 ? "rd" : "th"} of ${n}`,
            money(nextSeasonCap(i + 1, n)),
          ])}
        />
      </Panel>

      <BackupTools exportBackup={exportBackup} restoreBackup={restoreBackup} restoreFromNightlyBackup={restoreFromNightlyBackup} />

      <PlayerDatabaseTools playerDatabase={playerDatabase} importPlayerDatabase={importPlayerDatabase}
        clearPlayerDatabase={clearPlayerDatabase} />

      <EndSeasonTools endSeason={endSeason} season={season} seasonHistory={seasonHistory} standings={standings} teams={teams} />

      <AdminTools teams={teams} resetAll={resetAll} changeAdminPin={changeAdminPin}
        addFundsToTeam={addFundsToTeam} addEarned86Slot={addEarned86Slot} />
    </div>
  );
}

function BackupTools({ exportBackup, restoreBackup, restoreFromNightlyBackup }) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [nightlyBackups, setNightlyBackups] = useState(null); // null = not loaded yet
  const [loadingList, setLoadingList] = useState(false);
  const [restoringKey, setRestoringKey] = useState(null);

  const doExport = () => {
    exportBackup();
    setMsg({ text: "Backup downloaded — save that file somewhere safe.", tone: "green" });
  };

  const handleFile = (file) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    const reader = new FileReader();
    reader.onerror = () => { setBusy(false); setMsg({ text: "Couldn't read that file.", tone: "red" }); };
    reader.onload = () => {
      const err = restoreBackup(pin, reader.result);
      setBusy(false);
      if (err) setMsg({ text: err, tone: "red" });
      else setMsg({ text: "Backup restored.", tone: "green" });
    };
    reader.readAsText(file);
  };

  const loadNightlyBackups = async () => {
    setLoadingList(true);
    setMsg(null);
    try {
      const list = await listByPrefix(NIGHTLY_BACKUP_PREFIX);
      setNightlyBackups(list);
    } catch (e) {
      setMsg({ text: "Couldn't load the list of automatic backups.", tone: "red" });
    } finally {
      setLoadingList(false);
    }
  };

  const doRestoreNightly = async (key) => {
    setRestoringKey(key);
    const err = await restoreFromNightlyBackup(pin, key);
    setRestoringKey(null);
    if (err) setMsg({ text: err, tone: "red" });
    else setMsg({ text: "Restored from automatic backup.", tone: "green" });
  };

  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Save}>Backup & Restore</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 16, lineHeight: 1.6 }}>
        The league also backs itself up automatically every night at 11:59pm (see setup note below) — download a
        manual backup too occasionally, or before anything risky like a season reset, and keep the file somewhere safe.
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 18 }}>
        <Btn icon={Download} onClick={doExport}>Download backup (.json)</Btn>
      </div>

      <div style={{ paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Restore from a Backup File</div>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 10 }}>
          This replaces all current league data for everyone using this app — requires the admin PIN.
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="Admin PIN">
            <TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 140 }} />
          </Field>
          <label style={{
            cursor: "pointer", color: C.text, display: "inline-flex", alignItems: "center", gap: 6,
            border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 13.5, fontWeight: 700,
          }}>
            <Upload size={14} /> {busy ? "Restoring…" : "Choose backup file…"}
            <input type="file" accept="application/json" style={{ display: "none" }} disabled={busy}
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        </div>
      </div>

      <div style={{ paddingTop: 16, marginTop: 16, borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Automatic Nightly Backups</div>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 10 }}>
          Written automatically every night at 11:59pm by a scheduled Supabase job (see the setup note in the
          project README — this needs a one-time Edge Function + Cron Job setup to actually run).
        </div>
        {nightlyBackups === null ? (
          <Btn variant="outline" size="sm" onClick={loadNightlyBackups} disabled={loadingList}>
            {loadingList ? "Loading…" : "Check for automatic backups"}
          </Btn>
        ) : nightlyBackups.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12.5 }}>No automatic backups found yet — they'll appear here after the nightly job has run at least once.</div>
        ) : (
          <div className="grid gap-2">
            {nightlyBackups.slice(0, 14).map((b) => (
              <div key={b.key} className="flex items-center justify-between" style={{ background: C.panelAlt, borderRadius: 8, padding: "7px 10px" }}>
                <span style={{ color: C.text, fontSize: 12.5 }}>{b.key.replace(NIGHTLY_BACKUP_PREFIX, "")}</span>
                <Btn size="sm" variant="outline" onClick={() => doRestoreNightly(b.key)} disabled={restoringKey === b.key}>
                  {restoringKey === b.key ? "Restoring…" : "Restore this one"}
                </Btn>
              </div>
            ))}
          </div>
        )}
      </div>

      {msg && (
        <div className="flex items-center gap-2" style={{ marginTop: 14, color: msg.tone === "green" ? C.green : C.red, fontSize: 12.5 }}>
          {msg.tone === "green" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {msg.text}
        </div>
      )}
    </Panel>
  );
}

// Sofifa's official position codes (from their API docs), mapped down to this app's simpler
// position set used everywhere else (POSITIONS array).
const SOFIFA_POSITION_MAP = {
  0: "GK", 1: "CB", 2: "RWB", 3: "RB", 4: "CB", 5: "CB", 6: "CB", 7: "LB", 8: "LWB",
  9: "CDM", 10: "CDM", 11: "CDM", 12: "RM", 13: "CM", 14: "CM", 15: "CM", 16: "LM",
  17: "CAM", 18: "CAM", 19: "CAM", 20: "CF", 21: "CF", 22: "CF", 23: "RW", 24: "ST",
  25: "ST", 26: "ST", 27: "LW", 28: "ST", 29: "ST",
};
const sofifaPosition = (code) => SOFIFA_POSITION_MAP[code] ?? "ST";

// Sofifa's server blocks direct browser requests, so this goes through a small Supabase Edge
// Function ("sofifa-proxy") that fetches from Sofifa server-side and hands the result back.
async function sofifaFetch(path) {
  const url = `${supabaseUrl}/functions/v1/sofifa-proxy?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${supabaseAnonKey}`,
      apikey: supabaseAnonKey,
    },
  });
  if (!res.ok) throw new Error(`Sofifa proxy returned ${res.status}`);
  const json = await res.json();
  return json.data;
}

function mapSofifaPlayer(p, clubName) {
  return {
    name: p.commonName || `${p.firstName} ${p.lastName}`,
    position: sofifaPosition(p.position1),
    rating: p.overallRating,
    club: clubName,
    age: p.age,
    value: (p.price || 0) / 1000000, // Sofifa returns raw £, we track £M
    wage: (p.wage || 0) / 1000,      // Sofifa returns raw £/week, we track £k/week
  };
}

const PLAYER_FIELD_OPTIONS = [
  { value: "ignore", label: "Ignore this column" },
  { value: "name", label: "Player Name" },
  { value: "position", label: "Position" },
  { value: "rating", label: "Rating / OVR" },
  { value: "club", label: "Club" },
  { value: "age", label: "Age" },
  { value: "value", label: "Value (£M)" },
  { value: "wage", label: "Wage (£k/week)" },
];

function parsePastedTable(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], columnCount: 0 };
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map((l) => l.split(delimiter).map((c) => c.trim()));
  const columnCount = Math.max(...rows.map((r) => r.length));
  return { rows, columnCount, delimiter };
}

function guessFieldForColumn(headerText) {
  const h = (headerText || "").toLowerCase();
  if (/name|player/.test(h)) return "name";
  if (/pos/.test(h)) return "position";
  if (/rat|ovr|overall/.test(h)) return "rating";
  if (/club|team/.test(h)) return "club";
  if (/wage|salary/.test(h)) return "wage";
  if (/\bage\b/.test(h)) return "age";
  if (/value|transfer|price|worth/.test(h)) return "value";
  return "ignore";
}

function SofifaImport({ importPlayerDatabase }) {
  const [mode, setMode] = useState("league"); // "league" | "club"
  const [leagues, setLeagues] = useState([]); // {id, name}
  const [teams, setTeams] = useState([]); // {id, name, league}
  const [roster, setRoster] = useState(null);
  const [loadingData, setLoadingData] = useState(false);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);

  const [progress, setProgress] = useState(null); // { current, total, label }
  const busy = progress !== null;

  const loadData = async () => {
    setLoadingData(true);
    setMsg(null);
    try {
      const leagueList = await sofifaFetch("/leagues");
      const latestRoster = leagueList.reduce((max, l) => (l.latestRoster > max ? l.latestRoster : max), "0");
      setRoster(latestRoster);
      // Leagues can repeat across game years — keep one entry per league id, using its own latestRoster.
      const seen = new Map();
      leagueList.forEach((l) => { if (!seen.has(l.id)) seen.set(l.id, { id: l.id, name: l.name, roster: l.latestRoster }); });
      setLeagues(Array.from(seen.values()));
      const teamList = await sofifaFetch(`/teams/${latestRoster}`);
      setTeams(teamList.map((t) => ({ id: t.id, name: t.name, league: t.league?.name || "" })));
    } catch (e) {
      setMsg({
        text: "Couldn't reach the Sofifa proxy. Make sure the \"sofifa-proxy\" Edge Function is deployed in your Supabase project (Rules tab setup instructions cover this).",
        tone: "red",
      });
    } finally {
      setLoadingData(false);
    }
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = mode === "league" ? leagues : teams;
    if (!q) return [];
    return list.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, mode, leagues, teams]);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const importClub = async () => {
    setProgress({ current: 0, total: 1, label: selected.name });
    setMsg(null);
    try {
      const team = await sofifaFetch(`/team/${selected.id}/${roster}`);
      const players = (team.players || []).map((p) => mapSofifaPlayer(p, team.name));
      const err = importPlayerDatabase(pin, players, "merge");
      if (err) setMsg({ text: err, tone: "red" });
      else setMsg({ text: `Imported ${players.length} players from ${team.name}.`, tone: "green" });
    } catch (e) {
      setMsg({ text: "Couldn't load that squad from Sofifa — try again in a moment.", tone: "red" });
    } finally {
      setProgress(null);
    }
  };

  const importLeague = async () => {
    setMsg(null);
    try {
      const clubTeams = await sofifaFetch(`/league/${selected.id}/${selected.roster}`);
      const allPlayers = [];
      for (let i = 0; i < clubTeams.length; i++) {
        const t = clubTeams[i];
        setProgress({ current: i + 1, total: clubTeams.length, label: t.name });
        try {
          const full = await sofifaFetch(`/team/${t.id}/${selected.roster}`);
          (full.players || []).forEach((p) => allPlayers.push(mapSofifaPlayer(p, full.name)));
        } catch (e) {
          // one club failing shouldn't kill the whole league import — just skip it and keep going
        }
        await sleep(250); // stay comfortably under Sofifa's 60 requests/minute limit
      }
      const err = importPlayerDatabase(pin, allPlayers, "merge");
      if (err) setMsg({ text: err, tone: "red" });
      else setMsg({ text: `Imported ${allPlayers.length} players from ${clubTeams.length} clubs in ${selected.name}.`, tone: "green" });
    } catch (e) {
      setMsg({ text: "Couldn't load that league from Sofifa — try again in a moment.", tone: "red" });
    } finally {
      setProgress(null);
    }
  };

  const hasData = mode === "league" ? leagues.length > 0 : teams.length > 0;

  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div className="flex items-center justify-between flex-wrap gap-2" style={{ marginBottom: 10 }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>Import from Sofifa</div>
        <div className="flex gap-2">
          <Btn size="sm" variant={mode === "league" ? "primary" : "outline"} onClick={() => { setMode("league"); setSelected(null); setQuery(""); }}>Whole league</Btn>
          <Btn size="sm" variant={mode === "club" ? "primary" : "outline"} onClick={() => { setMode("club"); setSelected(null); setQuery(""); }}>Single club</Btn>
        </div>
      </div>

      {!hasData ? (
        <Btn onClick={loadData} disabled={loadingData}>{loadingData ? "Loading…" : "Load leagues & clubs from Sofifa"}</Btn>
      ) : (
        <div className="grid gap-3">
          <Field label={mode === "league" ? `Search leagues (${leagues.length} loaded)` : `Search clubs (${teams.length} loaded)`}>
            <TextInput placeholder={mode === "league" ? "e.g. Premier League" : "e.g. Arsenal"} value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(null); }} disabled={busy} />
          </Field>
          {matches.length > 0 && !selected && (
            <div className="grid gap-1">
              {matches.map((t) => (
                <button key={t.id} onClick={() => { setSelected(t); setQuery(t.name); }}
                  style={{ textAlign: "left", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer", color: C.text, fontSize: 12.5 }}>
                  {t.name}{t.league ? <span style={{ color: C.muted }}> · {t.league}</span> : null}
                </button>
              ))}
            </div>
          )}
          {selected && !busy && (
            <div className="flex items-end gap-2 flex-wrap">
              <Field label="Admin PIN">
                <TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 140 }} />
              </Field>
              <Btn onClick={mode === "league" ? importLeague : importClub}>
                Import {selected.name}{mode === "league" ? " (all clubs)" : "'s squad"}
              </Btn>
              <Btn variant="outline" size="sm" onClick={() => { setSelected(null); setQuery(""); }}>Change {mode === "league" ? "league" : "club"}</Btn>
            </div>
          )}
          {busy && (
            <div style={{ color: C.muted, fontSize: 12.5 }}>
              Importing… {progress.current}/{progress.total} — {progress.label}
              {progress.total > 1 && (
                <div style={{ background: C.border, borderRadius: 6, height: 6, marginTop: 6, overflow: "hidden" }}>
                  <div style={{ background: C.gold, height: "100%", width: `${(progress.current / progress.total) * 100}%`, transition: "width .2s" }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {msg && (
        <div className="flex items-center gap-2" style={{ marginTop: 10, color: msg.tone === "green" ? C.green : C.red, fontSize: 12.5 }}>
          {msg.tone === "green" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {msg.text}
        </div>
      )}
    </div>
  );
}

function PlayerDatabaseTools({ playerDatabase, importPlayerDatabase, clearPlayerDatabase }) {
  const [raw, setRaw] = useState("");
  const [hasHeaders, setHasHeaders] = useState(true);
  const [mapping, setMapping] = useState([]); // field per column index
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);

  const parsed = useMemo(() => parsePastedTable(raw), [raw]);

  useEffect(() => {
    if (parsed.columnCount === 0) { setMapping([]); return; }
    const headerRow = hasHeaders ? parsed.rows[0] : [];
    setMapping(Array.from({ length: parsed.columnCount }, (_, i) => guessFieldForColumn(headerRow[i])));
  }, [parsed.columnCount, hasHeaders]); // eslint-disable-line react-hooks/exhaustive-deps

  const dataRows = hasHeaders ? parsed.rows.slice(1) : parsed.rows;

  const buildPlayers = () => {
    const nameCol = mapping.indexOf("name");
    if (nameCol === -1) return [];
    return dataRows.map((row) => {
      const p = {};
      mapping.forEach((field, i) => {
        if (field !== "ignore") p[field] = row[i];
      });
      return p;
    }).filter((p) => p.name);
  };

  const preview = buildPlayers().slice(0, 5);

  const doImport = (mode) => {
    const players = buildPlayers();
    const err = importPlayerDatabase(pin, players, mode);
    if (err) setMsg({ text: err, tone: "red" });
    else {
      setMsg({ text: `Imported ${players.length} players (${mode === "replace" ? "replaced database" : "merged into existing database"}).`, tone: "green" });
      setRaw("");
    }
  };

  const doClear = () => {
    if (!window.confirm("Clear the entire imported player database? This doesn't affect any squads or transfers, just the autocomplete list.")) return;
    const err = clearPlayerDatabase(pin);
    if (err) setMsg({ text: err, tone: "red" });
    else setMsg({ text: "Player database cleared.", tone: "green" });
  };

  return (
    <Panel style={{ padding: 18 }}>
      <SectionTitle icon={Search}>Player Database (for autocomplete)</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
        Pull real club squads directly from{" "}
        <a href="https://sofifa.com/" target="_blank" rel="noopener noreferrer" style={{ color: C.gold }}>Sofifa</a>
        {" "}below, or paste a copied table from{" "}
        <a href="https://cmtracker.net/" target="_blank" rel="noopener noreferrer" style={{ color: C.gold }}>CMTracker.net</a>
        {" "}(or anywhere else) further down. Once imported, every "Player name" field in Transfers and
        Auctions will suggest matching players as you type, and picking one auto-fills their position,
        rating, club, age, wage, and a suggested bid (their value rounded up to the nearest £250,000).
        Currently <b style={{ color: C.gold }}>{playerDatabase.length} players</b> in the database.
      </div>

      <SofifaImport importPlayerDatabase={importPlayerDatabase} />

      <div style={{ margin: "20px 0", paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Or Paste From Anywhere Else</div>
      </div>

      <Field label="Paste data here (tab or comma separated)">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={"Name\tPosition\tRating\tClub\tAge\tValue\tWage\nErling Haaland\tST\t91\tMan City\t25\t185\t350"}
          rows={6}
          style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
        />
      </Field>

      {parsed.columnCount > 0 && (
        <>
          <div className="flex items-center gap-2" style={{ marginTop: 10, marginBottom: 10 }}>
            <input type="checkbox" checked={hasHeaders} onChange={(e) => setHasHeaders(e.target.checked)} id="hasHeaders" />
            <label htmlFor="hasHeaders" style={{ color: C.muted, fontSize: 12.5 }}>First row is column headers (not a player)</label>
          </div>

          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Map each column</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${parsed.columnCount}, minmax(120px, 1fr))`, marginBottom: 14, overflowX: "auto" }}>
            {mapping.map((field, i) => (
              <div key={i}>
                <div style={{ color: C.muted, fontSize: 10.5, marginBottom: 3 }}>
                  Column {i + 1}{hasHeaders && parsed.rows[0][i] ? ` (${parsed.rows[0][i]})` : ""}
                </div>
                <Select value={field} onChange={(e) => setMapping((m) => m.map((f, j) => (j === i ? e.target.value : f)))} style={{ fontSize: 12 }}>
                  {PLAYER_FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
            ))}
          </div>

          {!mapping.includes("name") && (
            <div className="flex items-center gap-2" style={{ marginBottom: 10, color: C.red, fontSize: 12.5 }}>
              <AlertTriangle size={13} /> You need to map one column as "Player Name" before importing.
            </div>
          )}

          {preview.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <Label>Preview ({dataRows.length} rows total)</Label>
              <Table dense head={["Name", "Pos", "Rating", "Club", "Age", "Value", "Wage"]}
                rows={preview.map((p) => [p.name, p.position || "—", p.rating || "—", p.club || "—", p.age || "—", p.value ? money(roundUpTo250k(p.value)) : "—", p.wage ? `£${p.wage}k` : "—"])} />
            </div>
          )}

          <div className="flex items-end gap-2 flex-wrap">
            <Field label="Admin PIN">
              <TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 140 }} />
            </Field>
            <Btn icon={Upload} onClick={() => doImport("merge")} disabled={!mapping.includes("name")}>Merge into database</Btn>
            <Btn variant="outline" onClick={() => doImport("replace")} disabled={!mapping.includes("name")}>Replace entire database</Btn>
          </div>
        </>
      )}

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <Btn variant="danger" size="sm" icon={Trash2} onClick={doClear}>Clear player database</Btn>
      </div>

      {msg && (
        <div className="flex items-center gap-2" style={{ marginTop: 14, color: msg.tone === "green" ? C.green : C.red, fontSize: 12.5 }}>
          {msg.tone === "green" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {msg.text}
        </div>
      )}
    </Panel>
  );
}

function EndSeasonTools({ endSeason, season, seasonHistory, standings, teams }) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);
  const top3 = standings.slice(0, 3);
  const n = teams.length;

  const doEndSeason = () => {
    const err = endSeason(pin);
    if (err) setMsg({ text: err, tone: "red" });
    else { setMsg({ text: `Season ${season} archived — welcome to Season ${season + 1}.`, tone: "green" }); setPin(""); }
  };

  return (
    <Panel style={{ padding: 18, border: `1px solid ${C.gold}55` }}>
      <SectionTitle icon={CalendarClock}>End of Season</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
        Currently <b style={{ color: C.gold }}>Season {season}</b>. When the fixtures are done, ending the season
        locks in final standings, gives every team their new wage cap based on where they finished, and tops up each
        team's leftover budget by position — <b style={{ color: C.gold }}>£{SEASON_BOOST_MAX}M for 1st</b> down to
        <b style={{ color: C.gold }}> £{SEASON_BOOST_MIN}M for last</b> — added on top of whatever they didn't spend
        this season, not a flat reset. This season's fixtures/transfers/prizes get archived for the record. Squads
        (players) carry over untouched. Requires the admin PIN — any live auctions need resolving first.
      </div>

      {top3.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Label>Current standings (top 3, if season ended now)</Label>
          <Table
            dense
            head={["Pos", "Team", "Points", "Budget Top-Up", "Next Wage Cap"]}
            rows={top3.map((r) => [
              r.position, teams.find((t) => t.id === r.id)?.name, r.points,
              `+${money(seasonBudgetBoost(r.position, n))}`, money(r.nextCap),
            ])}
          />
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap">
        <Field label="Admin PIN">
          <TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 140 }} />
        </Field>
        <Btn variant="danger" icon={CalendarClock} onClick={doEndSeason}>End Season {season}</Btn>
      </div>
      {msg && (
        <div className="flex items-center gap-2" style={{ marginTop: 12, color: msg.tone === "green" ? C.green : C.red, fontSize: 12.5 }}>
          {msg.tone === "green" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {msg.text}
        </div>
      )}

      {seasonHistory.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Past Seasons</div>
          <Table
            dense
            head={["Season", "Champion", "Points", "Ended"]}
            rows={seasonHistory.map((h) => {
              const champ = h.standings.find((s) => s.position === 1);
              return [h.season, champ?.teamName || "—", champ?.points ?? "—", new Date(h.endedAt).toLocaleDateString()];
            })}
          />
        </div>
      )}
    </Panel>
  );
}

function AdminTools({ teams, resetAll, changeAdminPin, addFundsToTeam, addEarned86Slot }) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null); // { text, tone }
  const [showChangePin, setShowChangePin] = useState(false);
  const [newPinInput, setNewPinInput] = useState("");

  const [fundsTeam, setFundsTeam] = useState(teams[0]?.id || "");
  const [fundsAmount, setFundsAmount] = useState("");

  const [slotTeam, setSlotTeam] = useState(teams[0]?.id || "");
  const [slotAmount, setSlotAmount] = useState(1);

  const show = (text, tone) => setMsg({ text, tone });

  const doReset = async () => {
    setMsg(null);
    const err = await resetAll(pin);
    if (err) show(err, "red");
    else show("League data has been reset.", "green");
  };

  const doChangePin = () => {
    const err = changeAdminPin(pin, newPinInput);
    if (err) show(err, "red");
    else {
      show("Admin PIN updated.", "green");
      setNewPinInput("");
      setShowChangePin(false);
    }
  };

  const doAddFunds = () => {
    const err = addFundsToTeam(pin, fundsTeam, fundsAmount);
    if (err) show(err, "red");
    else {
      const t = teams.find((x) => x.id === fundsTeam);
      show(`Added ${money(fundsAmount)} to ${t?.name}.`, "green");
      setFundsAmount("");
    }
  };

  const doAddSlot = () => {
    const err = addEarned86Slot(pin, slotTeam, slotAmount);
    if (err) show(err, "red");
    else {
      const t = teams.find((x) => x.id === slotTeam);
      show(`Added ${slotAmount} × 86+ slot${Math.abs(slotAmount) === 1 ? "" : "s"} to ${t?.name}.`, "green");
      setSlotAmount(1);
    }
  };

  return (
    <Panel style={{ padding: 18, border: `1px solid ${C.red}55` }}>
      <SectionTitle icon={Lock}>Admin Tools</SectionTitle>
      <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 14 }}>
        These actions affect the whole league for everyone using this app. Enter the admin PIN once below, then use
        any of the tools. Default PIN is <b style={{ color: C.gold }}>2026</b>.
      </div>

      <div style={{ maxWidth: 280, marginBottom: 18 }}>
        <Field label="Admin PIN">
          <TextInput type="password" placeholder="Enter admin PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        </Field>
      </div>

      {/* Add funds */}
      <div style={{ paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Add Funds to a Team</div>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 10 }}>
          For end-of-season budget increases, prize payouts, or corrections. Use a negative amount to deduct.
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
          <Field label="Team">
            <Select value={fundsTeam} onChange={(e) => setFundsTeam(e.target.value)}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name} — {money(t.budget)}</option>)}
            </Select>
          </Field>
          <Field label="Amount (£M)">
            <TextInput type="number" step="0.25" placeholder="e.g. 50" value={fundsAmount} onChange={(e) => setFundsAmount(e.target.value)} />
          </Field>
          <Btn icon={Plus} onClick={doAddFunds}>Add funds</Btn>
        </div>
      </div>

      {/* Add 86+ slot */}
      <div style={{ paddingTop: 18, marginTop: 18, borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Add 86+ Slot to a Team</div>
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 10 }}>
          Awards an extra 86+ rated slot on top of the base 3 (e.g. earned via a win, or the new-season bonus). Use a
          negative number to remove one.
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
          <Field label="Team">
            <Select value={slotTeam} onChange={(e) => setSlotTeam(e.target.value)}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name} — {3 + (t.earned86 || 0)} allowed</option>)}
            </Select>
          </Field>
          <Field label="Slots to add">
            <TextInput type="number" step="1" value={slotAmount} onChange={(e) => setSlotAmount(e.target.value)} />
          </Field>
          <Btn icon={Plus} onClick={doAddSlot}>Add slot(s)</Btn>
        </div>
      </div>

      {/* Reset + change pin */}
      <div style={{ paddingTop: 18, marginTop: 18, borderTop: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-2 flex-wrap">
          <Btn variant="danger" icon={RotateCcw} onClick={doReset}>Reset all league data</Btn>
          <Btn variant="outline" icon={KeyRound} onClick={() => setShowChangePin((s) => !s)}>
            {showChangePin ? "Cancel" : "Change PIN"}
          </Btn>
        </div>
        {showChangePin && (
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr auto", alignItems: "end", marginTop: 12, maxWidth: 420 }}>
            <Field label="New PIN (min 4 characters, uses PIN above as current)">
              <TextInput type="password" value={newPinInput} onChange={(e) => setNewPinInput(e.target.value)} />
            </Field>
            <Btn icon={Unlock} onClick={doChangePin}>Save new PIN</Btn>
          </div>
        )}
      </div>

      {msg && (
        <div className="flex items-center gap-2" style={{ marginTop: 16, color: msg.tone === "green" ? C.green : C.red, fontSize: 12.5 }}>
          {msg.tone === "green" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {msg.text}
        </div>
      )}

      <div style={{ marginTop: 14, color: C.muted, fontSize: 11.5, lineHeight: 1.6 }}>
        Heads up: this PIN is a light deterrent, not real security — anyone who views this app's source could find it.
        It's meant to stop accidental clicks by managers, not a malicious admin.
      </div>
    </Panel>
  );
}

function RuleBlock({ title, children }) {
  return (
    <div>
      <div style={{ color: C.gold, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <div style={{ color: C.muted }}>{children}</div>
    </div>
  );
}
