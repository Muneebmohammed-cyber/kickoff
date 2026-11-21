// Kickoff community: accounts, fan feed, fan clubs, match chat, predictions, pickup games, turf booking.
// Backend: Firebase (Google sign-in + Firestore). Talks to the main app through window.KO.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion, arrayRemove, increment, writeBatch, runTransaction } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const K = window.KO;
const { esc, toast } = K;
const $ = s => document.querySelector(s);
const READY = !!FIREBASE_CONFIG.apiKey;
let app, auth, db;
if (READY) {
  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { db = initializeFirestore(app, {}); }
}

let ME = null, PROFILE = null;
const SUBS = {};               // live listeners by key
const unsub = k => { if (SUBS[k]) { SUBS[k](); delete SUBS[k]; } };
const C = { view: 'feed' };     // community sub-view

/* ---------------- helpers ---------------- */
const ts = x => x?.toMillis ? x.toMillis() : (typeof x === 'number' ? x : Date.now());
const ago = x => K.ago(ts(x));
const avatar = (url, name, cls = 'av') => url
  ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;${cls} ini&quot;>${esc((name || '?').slice(0, 1))}</span>'">`
  : `<span class="${cls} ini">${esc((name || '?').slice(0, 1))}</span>`;
const me = () => ({ uid: ME.uid, name: PROFILE?.name || ME.displayName || 'Fan', photo: PROFILE?.photo || ME.photoURL || '', team: PROFILE?.team || null });
const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const ymd = d => { d = new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const wa = (phone, text) => 'https://wa.me/' + String(phone || '').replace(/[^\d]/g, '') + '?text=' + encodeURIComponent(text);
let confirmKey = null;
function confirmTap(btn, key, label = 'Tap again to confirm') { // in-app two-tap confirm (no browser dialogs)
  if (confirmKey === key) { confirmKey = null; return true; }
  confirmKey = key; const old = btn.textContent; btn.textContent = label; btn.classList.add('warn');
  setTimeout(() => { if (confirmKey === key) { confirmKey = null; btn.textContent = old; btn.classList.remove('warn'); } }, 3000);
  return false;
}

// compress a picked photo to a small JPEG data URL (stored inside Firestore docs)
function compress(file, max = 1000, q = 0.62, cap = 300000) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let out = c.toDataURL('image/jpeg', q);
      if (out.length > cap) out = c.toDataURL('image/jpeg', 0.42);
      if (out.length > cap) { const k = Math.sqrt(cap / out.length); const c2 = document.createElement('canvas'); c2.width = Math.round(c.width * k); c2.height = Math.round(c.height * k); c2.getContext('2d').drawImage(c, 0, 0, c2.width, c2.height); out = c2.toDataURL('image/jpeg', 0.5); }
      res(out);
    };
    img.onerror = rej; img.src = url;
  });
}

/* ---------------- auth ---------------- */
if (READY) {
  getRedirectResult(auth).catch(() => {});
  onAuthStateChanged(auth, async u => {
    ME = u;
    if (u) {
      const ref = doc(db, 'users', u.uid);
      try {
        const s = await getDoc(ref);
        if (s.exists()) PROFILE = s.data();
        else { PROFILE = { name: u.displayName || 'Fan', photo: u.photoURL || '', city: '', position: '', team: null, bio: '', clubs: [], joined: serverTimestamp() }; await setDoc(ref, PROFILE); toast('Welcome to Kickoff, ' + (u.displayName || '').split(' ')[0] + '!'); }
      } catch (e) { PROFILE = { name: u.displayName, photo: u.photoURL, clubs: [] }; }
      watchMine();
    } else { PROFILE = null; ['myb', 'owner'].forEach(unsub); setBadge(0); }
    updateAvatar();
    if (u && K.topKey() === 'login') history.back(); else K.refreshView();
  });
}
async function login() {
  if (!READY) return toast('Community is being set up — try again soon');
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (/popup-blocked|operation-not-supported|web-storage/.test(e.code || '')) return signInWithRedirect(auth, p);
    if (!/popup-closed|cancelled/.test(e.code || '')) toast('Sign-in failed: ' + (e.code || e.message));
  }
}
function signInCard(why) {
  return `<div class="card signin"><b>Join the Kickoff community</b><div class="meta">${esc(why)}</div><button class="btn" data-kc="login" style="margin-top:10px">Sign in with Google</button></div>`;
}
function need(why, fn) { if (ME) return fn(); K.pushSheet('login', () => K.openSheet('Sign in', signInCard(why))); }
function updateAvatar() {
  const b = $('#meBtn'); if (!b) return;
  b.innerHTML = ME ? avatar(PROFILE?.photo || ME.photoURL, PROFILE?.name || ME.displayName, 'av sm') : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
}
function setBadge(n) {
  const b = document.querySelector('#tabs [data-tab=turfs]'); if (!b) return;
  let s = b.querySelector('.badge'); if (!s) { s = document.createElement('span'); s.className = 'badge'; b.appendChild(s); }
  s.textContent = n; s.hidden = !n;
}
// watch my bookings (status changes) and, for owners, pending requests
let MYB = [], OWNERB = [];
function watchMine() {
  unsub('myb'); unsub('owner');
  let first = true;
  SUBS.myb = onSnapshot(query(collection(db, 'bookings'), where('userId', '==', ME.uid)), s => {
    if (!first) s.docChanges().forEach(c => { if (c.type === 'modified') { const b = c.doc.data(); if (b.status === 'confirmed') toast('✅ ' + b.turfName + ' confirmed your booking'); if (b.status === 'declined') toast('❌ ' + b.turfName + ' declined your booking'); } });
    first = false; MYB = s.docs.map(d => ({ id: d.id, ...d.data() }));
  }, () => {});
  SUBS.owner = onSnapshot(query(collection(db, 'bookings'), where('ownerId', '==', ME.uid), where('status', '==', 'pending')), s => {
    const added = s.docChanges().filter(c => c.type === 'added').length;
    if (OWNERB.length && added) toast('📅 New booking request');
    OWNERB = s.docs.map(d => ({ id: d.id, ...d.data() })); setBadge(OWNERB.length);
  }, () => {});
}

/* ---------------- FANS: sub-navigation ---------------- */
function fansBar() {
  const v = [['feed', 'Feed'], ['clubs', 'Fan clubs'], ['predict', 'Predict'], ['play', 'Play']];
  return `<div class="seg2">${v.map(([k, n]) => `<button class="${C.view === k ? 'on' : ''}" data-kcv="${k}">${n}</button>`).join('')}</div>`;
}
function renderFans() {
  if (!READY) { $('#view').innerHTML = '<div class="empty">Community is being set up. Check back shortly.</div>'; return; }
  ['feed', 'clubs', 'predict', 'play'].forEach(k => k !== C.view && unsub('v_' + k));
  ({ feed: renderFeed, clubs: renderClubs, predict: renderPredict, play: renderPlay })[C.view]();
}

/* ---------------- FEED ---------------- */
function composer(ctx = {}) {
  if (!ME) return signInCard('Post, comment and chat with other fans.');
  return `<button class="composer" data-kc="compose" data-club="${esc(ctx.club || '')}" data-clubname="${esc(ctx.clubName || '')}">${avatar(me().photo, me().name)}<span>${ctx.club ? 'Post in ' + esc(ctx.clubName) + '…' : 'Share something with the fans…'}</span><span class="cam">📷</span></button>`;
}
function postCard(p) {
  const liked = ME && (p.likes || []).includes(ME.uid);
  const mine = ME && p.uid === ME.uid;
  return `<article class="post" data-pid="${esc(p.id)}">
    <header>${avatar(p.photo, p.name)}<div class="pm"><b>${esc(p.name)}</b>${p.team?.logo ? `<img class="crest sm" src="${esc(p.team.logo)}" alt="" title="${esc(p.team.name)}">` : ''}<div class="meta">${ago(p.createdAt)}${p.clubName ? ' · in <a href="#" data-kc="club" data-club="' + esc(p.clubId) + '">' + esc(p.clubName) + '</a>' : ''}</div></div>
    ${mine ? `<button class="mini" data-kc="delpost" data-pid="${esc(p.id)}">Delete</button>` : ''}</header>
    ${p.text ? `<p class="ptext">${esc(p.text)}</p>` : ''}
    ${p.image ? `<img class="pimg" src="${p.image}" alt="" loading="lazy">` : ''}
    <footer><button class="act ${liked ? 'on' : ''}" data-kc="like" data-pid="${esc(p.id)}">${liked ? '♥' : '♡'} ${(p.likes || []).length || ''}</button>
    <button class="act" data-kc="post" data-pid="${esc(p.id)}">💬 ${p.comments || ''}</button>
    <button class="act" data-kc="sharepost" data-pid="${esc(p.id)}">↗</button></footer></article>`;
}
let POSTS = {};
function renderFeed() {
  $('#view').innerHTML = composer() + '<div id="feed"><div class="spin"></div></div>';
  unsub('v_feed');
  SUBS.v_feed = onSnapshot(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(60)), s => {
    const list = s.docs.map(d => ({ id: d.id, ...d.data() })); list.forEach(p => POSTS[p.id] = p);
    const box = $('#feed'); if (!box) return;
    box.innerHTML = list.length ? list.map(postCard).join('') : '<div class="empty">No posts yet. Be the first — share your take on today’s games.</div>';
  }, e => { const box = $('#feed'); if (box) box.innerHTML = '<div class="empty">Couldn’t load the feed.</div>'; });
}
let DRAFT_IMG = null;
function openCompose(club, clubName) {
  {
    DRAFT_IMG = null;
    K.openSheet(club ? clubName : 'New post', `<div class="form">
      <div class="row0">${avatar(me().photo, me().name)}<b>${esc(me().name)}</b></div>
      <textarea id="ptext" rows="5" maxlength="1500" placeholder="What’s on your mind? Match thoughts, banter, transfer rumours…"></textarea>
      <div id="pprev"></div>
      <div class="acts" style="justify-content:space-between"><label class="btn ghost">📷 Photo<input type="file" accept="image/*" id="pfile" hidden></label>
      <button class="btn" data-kc="publish" data-club="${esc(club || '')}" data-clubname="${esc(clubName || '')}">Post</button></div></div>`);
    $('#pfile').onchange = async e => { const f = e.target.files[0]; if (!f) return; DRAFT_IMG = await compress(f); $('#pprev').innerHTML = `<img class="pimg" src="${DRAFT_IMG}" alt="">`; };
    setTimeout(() => $('#ptext')?.focus(), 250);
  }
}
async function publish(btn) {
  const text = $('#ptext').value.trim();
  if (!text && !DRAFT_IMG) return toast('Write something or add a photo');
  btn.disabled = true; btn.textContent = 'Posting…';
  const m = me();
  try {
    await addDoc(collection(db, 'posts'), { uid: m.uid, name: m.name, photo: m.photo, team: m.team, text, image: DRAFT_IMG || null, clubId: btn.dataset.club || null, clubName: btn.dataset.clubname || null, likes: [], comments: 0, createdAt: serverTimestamp() });
    toast('Posted'); history.back();
  } catch (e) { toast('Couldn’t post: ' + (e.code || e.message)); btn.disabled = false; btn.textContent = 'Post'; }
}
async function toggleLike(pid) {
  need('Sign in to like posts.', async () => {
    const p = POSTS[pid]; const on = (p?.likes || []).includes(ME.uid);
    try { await updateDoc(doc(db, 'posts', pid), { likes: on ? arrayRemove(ME.uid) : arrayUnion(ME.uid) }); } catch (e) { toast('Couldn’t like'); }
  });
}
function openPost(pid) {
  const p = POSTS[pid]; if (!p) return;
  K.openSheet('Post', postCard(p) + `<div class="lg">Comments</div><div id="cmts"><div class="spin"></div></div>
    ${ME ? `<form class="chatbar" data-kcform="comment" data-pid="${esc(pid)}"><input id="ctext" maxlength="500" placeholder="Add a comment…" autocomplete="off"><button class="btn">Send</button></form>` : signInCard('Sign in to comment.')}`);
  unsub('cmts');
  SUBS.cmts = onSnapshot(query(collection(db, 'posts', pid, 'comments'), orderBy('createdAt', 'asc'), limit(200)), s => {
    const box = $('#cmts'); if (!box) return unsub('cmts');
    box.innerHTML = s.docs.length ? s.docs.map(d => { const c = d.data(); return `<div class="cmt">${avatar(c.photo, c.name, 'av xs')}<div><b>${esc(c.name)}</b> <span class="meta">${ago(c.createdAt)}</span><div>${esc(c.text)}</div></div></div>`; }).join('') : '<div class="meta" style="padding:8px 0">No comments yet.</div>';
  });
}
async function addComment(pid, input) {
  const text = input.value.trim(); if (!text) return; input.value = '';
  const m = me();
  try {
    await addDoc(collection(db, 'posts', pid, 'comments'), { uid: m.uid, name: m.name, photo: m.photo, text, createdAt: serverTimestamp() });
    await updateDoc(doc(db, 'posts', pid), { comments: increment(1) });
  } catch (e) { toast('Couldn’t comment'); }
}

/* ---------------- FAN CLUBS ---------------- */
async function renderClubs() {
  const mine = PROFILE?.clubs || [];
  let html = `<button class="btn ghost wide" data-kc="findclub">🔍 Find your club</button>`;
  html += `<div class="lg">Your clubs</div><div id="myclubs">${ME ? (mine.length ? '<div class="spin"></div>' : '<div class="meta">Join your team’s fan club to post with fellow fans and chat on match days.</div>') : signInCard('Join fan clubs for your teams.')}</div>`;
  html += `<div class="lg">Biggest fan clubs</div><div id="topclubs"><div class="spin"></div></div>`;
  $('#view').innerHTML = html;
  const card = c => `<button class="row" data-kc="club" data-club="${esc(c.id)}"><img src="${esc(c.logo)}" alt=""><div><b>${esc(c.name)}</b><div class="meta">${c.members || 0} member${c.members === 1 ? '' : 's'} · ${esc(K.LN[c.lg] || '')}</div></div><span style="margin-left:auto;color:var(--mute)">›</span></button>`;
  try {
    const top = await getDocs(query(collection(db, 'clubs'), orderBy('members', 'desc'), limit(20)));
    const all = top.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.members > 0);
    if ($('#topclubs')) $('#topclubs').innerHTML = all.length ? all.map(card).join('') : '<div class="meta">No fan clubs yet — start one for your team.</div>';
    if (ME && mine.length && $('#myclubs')) {
      const ds = await Promise.all(mine.slice(0, 20).map(id => getDoc(doc(db, 'clubs', String(id)))));
      $('#myclubs').innerHTML = ds.filter(d => d.exists()).map(d => card({ id: d.id, ...d.data() })).join('');
    }
  } catch (e) { if ($('#topclubs')) $('#topclubs').innerHTML = '<div class="meta">Couldn’t load clubs.</div>'; }
}
async function openClub(id) {
  id = String(id);
  K.openSheet('Fan club', '<div class="spin"></div>');
  let c = (await getDoc(doc(db, 'clubs', id)).catch(() => null))?.data();
  if (!c) { await K.loadTeams(); const t = (K.TEAMS() || []).find(x => x.id === id); if (!t) return ($('#sheetBody').innerHTML = '<div class="empty">Club not found.</div>'); c = { name: t.name, logo: t.logo, lg: t.lg, members: 0 }; }
  const joined = ME && (PROFILE?.clubs || []).map(String).includes(id);
  $('#sheetTitle').textContent = c.name + ' fans';
  $('#sheetBody').innerHTML = `<div class="clubhead"><img src="${esc(c.logo)}" alt=""><div><h2>${esc(c.name)}</h2><div class="meta" id="clubcount">${c.members || 0} member${c.members === 1 ? '' : 's'} · ${esc(K.LN[c.lg] || '')}</div></div></div>
    <div class="acts" style="justify-content:flex-start"><button class="btn ${joined ? 'ghost' : ''}" data-kc="joinclub" data-club="${esc(id)}">${joined ? '✓ Joined' : 'Join fan club'}</button><button class="btn ghost" data-team="${esc(id)}" data-tlg="${esc(c.lg)}">Team page</button></div>
    <div id="clubnext"></div>
    <div class="lg">Members</div><div id="clubmem" class="avrow"><div class="meta">…</div></div>
    <div class="lg">Club wall</div>${joined ? composer({ club: id, clubName: c.name }) : `<div class="meta">${ME ? 'Join to post on the club wall.' : ''}</div>`}<div id="clubfeed"><div class="spin"></div></div>`;
  CLUB = { id, ...c };
  // next match for the club → link to its fan chat
  K.get(K.API + c.lg + '/teams/' + id + '/schedule?fixture=true').then(j => {
    const n = (j.events || []).map(e => K.norm(e, c.lg)).filter(m => m.state !== 'post').sort((a, b) => new Date(a.date) - new Date(b.date))[0];
    if (n && $('#clubnext')) { K.TEAMEV().push(n); $('#clubnext').innerHTML = `<div class="lg">Next match</div>` + K.matchRow(n).replace('class="match"', 'class="match" data-te="1"') + '<div class="meta">Open it for the live fan chat and score predictions.</div>'; }
  }).catch(() => {});
  getDocs(query(collection(db, 'clubs', id, 'members'), limit(30))).then(s => { if ($('#clubmem')) $('#clubmem').innerHTML = s.docs.length ? s.docs.map(d => { const m = d.data(); return `<span title="${esc(m.name)}">${avatar(m.photo, m.name)}</span>`; }).join('') : '<div class="meta">No members yet.</div>'; }).catch(() => {});
  unsub('club');
  SUBS.club = onSnapshot(query(collection(db, 'posts'), where('clubId', '==', id), limit(80)), s => {
    const box = $('#clubfeed'); if (!box) return unsub('club');
    const list = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ts(b.createdAt) - ts(a.createdAt)); list.forEach(p => POSTS[p.id] = p);
    box.innerHTML = list.length ? list.map(postCard).join('') : '<div class="meta" style="padding:8px 0">Nothing on the wall yet.</div>';
  });
}
let CLUB = null;
async function toggleClub(id, btn) {
  need('Sign in to join fan clubs.', async () => {
    id = String(id); const joined = (PROFILE.clubs || []).map(String).includes(id);
    btn.disabled = true;
    try {
      let c = CLUB?.id === id ? CLUB : null;
      if (!c) { await K.loadTeams(); const t = (K.TEAMS() || []).find(x => x.id === id); c = { name: t?.name, logo: t?.logo, lg: t?.lg }; }
      const b = writeBatch(db);
      b.set(doc(db, 'clubs', id), { name: c.name, logo: c.logo, lg: c.lg, members: increment(joined ? -1 : 1) }, { merge: true });
      if (joined) b.delete(doc(db, 'clubs', id, 'members', ME.uid));
      else b.set(doc(db, 'clubs', id, 'members', ME.uid), { name: me().name, photo: me().photo, at: serverTimestamp() });
      b.update(doc(db, 'users', ME.uid), { clubs: joined ? arrayRemove(id) : arrayUnion(id) });
      await b.commit();
      PROFILE.clubs = joined ? PROFILE.clubs.filter(x => String(x) !== id) : [...(PROFILE.clubs || []), id];
      toast(joined ? 'Left the fan club' : 'Welcome to the ' + c.name + ' fan club!');
      if (!joined && !K.isFav(id)) K.follow({ id, name: c.name, logo: c.logo, lg: c.lg });
      openClub(id);
    } catch (e) { toast('Couldn’t update: ' + (e.code || e.message)); btn.disabled = false; }
  });
}

/* ---------------- MATCH PAGE: fan chat + prediction ---------------- */
function matchPane(m) {
  return `<div id="fansPane" data-mid="${esc(m.id)}"><div id="predbox"></div><div class="lg">Fan chat</div><div id="chat" class="chat"><div class="spin"></div></div>
    ${ME ? `<form class="chatbar" data-kcform="chat" data-path="chats/${esc(m.id)}/msgs"><input maxlength="300" placeholder="Say something to the fans…" autocomplete="off"><button class="btn">Send</button></form>` : signInCard('Sign in to chat with fans during the match.')}</div>`;
}
function mountMatch(m) {
  if (!READY) { const p = $('#fansPane'); if (p) p.innerHTML = '<div class="empty">Community is being set up.</div>'; return; }
  mountChat('chat_' + m.id, 'chats/' + m.id + '/msgs', '#chat');
  renderPredBox(m);
}
function mountChat(key, path, sel) {
  unsub('chat');
  const seg = path.split('/');
  SUBS.chat = onSnapshot(query(collection(db, ...seg), orderBy('createdAt', 'desc'), limit(120)), s => {
    const box = $(sel); if (!box) return unsub('chat');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const msgs = s.docs.map(d => d.data()).reverse();
    box.innerHTML = msgs.length ? msgs.map(c => `<div class="msg ${ME && c.uid === ME.uid ? 'mine' : ''}">${ME && c.uid === ME.uid ? '' : avatar(c.photo, c.name, 'av xs')}<div class="bubble">${ME && c.uid === ME.uid ? '' : `<b>${esc(c.name)}${c.team?.logo ? ` <img class="crest xs" src="${esc(c.team.logo)}" alt="">` : ''}</b>`}${esc(c.text)}<span class="t">${c.createdAt ? new Date(ts(c.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '…'}</span></div></div>`).join('') : '<div class="meta" style="padding:10px">No messages yet — start the conversation.</div>';
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = 1; }
  }, () => { const box = $(sel); if (box) box.innerHTML = '<div class="meta">Chat unavailable.</div>'; });
}
async function sendChat(path, input) {
  const text = input.value.trim(); if (!text) return; input.value = '';
  const m = me();
  try { await addDoc(collection(db, ...path.split('/')), { uid: m.uid, name: m.name, photo: m.photo, team: m.team, text, createdAt: serverTimestamp() }); }
  catch (e) { toast('Message not sent'); input.value = text; }
}
async function renderPredBox(m) {
  const box = $('#predbox'); if (!box) return;
  const pid = m.id + '_' + (ME?.uid || 'x');
  let mine = null;
  if (ME) mine = (await getDoc(doc(db, 'predictions', pid)).catch(() => null))?.data() || null;
  const all = await getDocs(query(collection(db, 'predictions'), where('matchId', '==', String(m.id)))).catch(() => null);
  const preds = all ? all.docs.map(d => d.data()) : [];
  const n = preds.length, hw = preds.filter(p => p.h > p.a).length, dr = preds.filter(p => p.h === p.a).length, aw = n - hw - dr;
  const pct = x => n ? Math.round(x / n * 100) : 0;
  const split = n ? `<div class="split"><i style="flex:${hw || .001}"></i><i style="flex:${dr || .001}"></i><i style="flex:${aw || .001}"></i></div><div class="splitlab"><span>${esc(m.h.name)} ${pct(hw)}%</span><span>Draw ${pct(dr)}%</span><span>${esc(m.a.name)} ${pct(aw)}%</span></div><div class="meta">${n} fan prediction${n === 1 ? '' : 's'}</div>` : '';
  if (m.state === 'pre') {
    const h = mine?.h ?? 1, a = mine?.a ?? 1;
    box.innerHTML = `<div class="card pred"><b>Predict the score</b><div class="meta">3 pts for the exact score, 1 pt for the right result. Locks at kick-off.</div>
      <div class="pgrid"><span>${esc(m.h.name)}</span><div class="step"><button type="button" data-kc="pstep" data-t="h" data-d="-1">−</button><b id="ph">${h}</b><button type="button" data-kc="pstep" data-t="h" data-d="1">+</button></div>
      <div class="step"><button type="button" data-kc="pstep" data-t="a" data-d="-1">−</button><b id="pa">${a}</b><button type="button" data-kc="pstep" data-t="a" data-d="1">+</button></div><span style="text-align:right">${esc(m.a.name)}</span></div>
      <button class="btn wide" data-kc="savepred" data-mid="${esc(m.id)}">${mine ? 'Update prediction' : 'Lock in prediction'}</button>${mine ? '<div class="meta" style="text-align:center;margin-top:6px">Your pick: ' + mine.h + '–' + mine.a + '</div>' : ''}${split}</div>`;
    PRED_M = m;
  } else {
    let res = '';
    if (mine) { const pts = points(mine, +m.h.score, +m.a.score); res = `<div>Your pick: <b>${mine.h}–${mine.a}</b>${m.state === 'post' ? ` · <b class="${pts ? 'ok' : ''}">${pts} pt${pts === 1 ? '' : 's'}</b>` : ''}</div>`; }
    box.innerHTML = (n || mine) ? `<div class="card pred"><b>Fan predictions</b>${res}${split}</div>` : '';
  }
}
let PRED_M = null;
const points = (p, h, a) => (p.h === h && p.a === a) ? 3 : (Math.sign(p.h - p.a) === Math.sign(h - a) ? 1 : 0);
async function savePred(btn) {
  need('Sign in to predict scores and climb the leaderboard.', async () => {
    const m = PRED_M; if (!m) return;
    if (new Date(m.date) <= Date.now()) return toast('Too late — it’s kicked off');
    const h = +$('#ph').textContent, a = +$('#pa').textContent, u = me();
    btn.disabled = true;
    try {
      await setDoc(doc(db, 'predictions', m.id + '_' + u.uid), { matchId: String(m.id), lg: m.lg, uid: u.uid, name: u.name, photo: u.photo, h, a, home: m.h.name, away: m.a.name, homeLogo: m.h.logo, awayLogo: m.a.logo, kickoff: new Date(m.date).getTime(), at: serverTimestamp() });
      toast('Prediction saved: ' + m.h.name + ' ' + h + '–' + a + ' ' + m.a.name); renderPredBox(m);
    } catch (e) { toast('Couldn’t save: ' + (e.code || e.message)); btn.disabled = false; }
  });
}

/* ---------------- PREDICT tab: upcoming matches + leaderboard ---------------- */
const PRED_LEAGUES = ['eng.1', 'esp.1', 'uefa.champions', 'ita.1', 'ger.1', 'fra.1', 'ksa.1', 'uefa.europa'];
async function renderPredict() {
  $('#view').innerHTML = `<div class="lg">Leaderboard</div><div id="lb"><div class="spin"></div></div><div class="lg">Predict upcoming games</div><div id="upc"><div class="spin"></div></div>`;
  loadLeaderboard();
  const days = [0, 1, 2, 3].map(o => { const d = new Date(); d.setDate(d.getDate() + o); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); });
  const lgs = [...new Set([...PRED_LEAGUES, ...K.S.favs.map(f => f.lg)])];
  const res = await Promise.allSettled(lgs.flatMap(lg => days.map(d => K.get(K.API + lg + '/scoreboard?dates=' + d).then(j => (j.events || []).map(e => K.norm(e, lg))))));
  const seen = new Set(), ms = [];
  res.forEach(r => r.status === 'fulfilled' && r.value.forEach(m => { if (!seen.has(m.id) && m.state === 'pre') { seen.add(m.id); ms.push(m); } }));
  ms.sort((a, b) => (K.isFav(b.h.id) || K.isFav(b.a.id)) - (K.isFav(a.h.id) || K.isFav(a.a.id)) || new Date(a.date) - new Date(b.date));
  let mine = {};
  if (ME) { const s = await getDocs(query(collection(db, 'predictions'), where('uid', '==', ME.uid))).catch(() => null); s?.docs.forEach(d => mine[d.data().matchId] = d.data()); }
  K.TEAMEV().push(...ms);
  const box = $('#upc'); if (!box) return;
  box.innerHTML = ms.length ? ms.slice(0, 40).map(m => `<button class="pcard" data-m="${esc(m.id)}" data-lg="${esc(m.lg)}" data-te="1" data-fans="1">
      <span class="meta">${fmtDay(m.date)} · ${K.tm(m.date)} · ${esc(K.LN[m.lg] || '')}</span>
      <span class="pt"><img class="crest" src="${esc(m.h.logo)}" alt="">${esc(m.h.name)}<b>${mine[m.id] ? mine[m.id].h + ' – ' + mine[m.id].a : 'vs'}</b>${esc(m.a.name)}<img class="crest" src="${esc(m.a.logo)}" alt=""></span>
      <span class="meta" style="color:${mine[m.id] ? 'var(--acc)' : 'var(--mute)'}">${mine[m.id] ? '✓ Predicted — tap to change' : 'Tap to predict'}</span></button>`).join('') : '<div class="meta">No upcoming games in the next few days.</div>';
}
async function loadLeaderboard() {
  const box = $('#lb');
  try {
    const s = await getDocs(query(collection(db, 'predictions'), where('kickoff', '<', Date.now() - 110 * 60000), limit(1500)));
    const ps = s.docs.map(d => d.data());
    const cache = K.store.get('results', {});
    const need_ = [...new Map(ps.filter(p => !cache[p.matchId]).map(p => [p.matchId, p])).values()];
    await Promise.allSettled(need_.slice(0, 60).map(p => K.get(K.API + p.lg + '/summary?event=' + p.matchId).then(j => {
      const c = j.header?.competitions?.[0]; if (c?.status?.type?.state !== 'post') return;
      const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
      cache[p.matchId] = [+h.score, +a.score];
    })));
    K.store.set('results', cache);
    const tbl = {};
    ps.forEach(p => { const r = cache[p.matchId]; if (!r) return; const t = tbl[p.uid] ||= { uid: p.uid, name: p.name, photo: p.photo, pts: 0, exact: 0, n: 0 }; const x = points(p, r[0], r[1]); t.pts += x; t.exact += x === 3; t.n++; });
    const rows = Object.values(tbl).sort((a, b) => b.pts - a.pts || b.exact - a.exact).slice(0, 25);
    if (box) box.innerHTML = rows.length ? `<div class="lbt">${rows.map((r, i) => `<div class="lbr ${ME && r.uid === ME.uid ? 'me' : ''}"><span class="rk">${i + 1}</span>${avatar(r.photo, r.name, 'av xs')}<span class="nm">${esc(r.name)}</span><span class="meta">${r.exact} exact · ${r.n} played</span><b>${r.pts}</b></div>`).join('')}</div>`
      : '<div class="meta">Points appear here once predicted games finish. Exact score = 3 pts, right result = 1 pt.</div>';
  } catch (e) { if (box) box.innerHTML = '<div class="meta">Leaderboard unavailable.</div>'; }
}

/* ---------------- PLAY: pickup games ---------------- */
async function renderPlay() {
  $('#view').innerHTML = `<button class="btn wide" data-kc="newgame">＋ Organise a game</button><div class="meta" style="text-align:center;margin:6px 0 4px">Short of players? Post a game and let others join.</div><div id="games"><div class="spin"></div></div>`;
  unsub('v_play');
  SUBS.v_play = onSnapshot(query(collection(db, 'games'), where('when', '>=', Date.now() - 2 * 3600e3), orderBy('when', 'asc'), limit(50)), s => {
    const box = $('#games'); if (!box) return;
    const list = s.docs.map(d => ({ id: d.id, ...d.data() })); list.forEach(g => GAMES[g.id] = g);
    box.innerHTML = list.length ? list.map(gameCard).join('') : '<div class="empty">No games planned. Organise one!</div>';
  }, () => { const box = $('#games'); if (box) box.innerHTML = '<div class="empty">Couldn’t load games.</div>'; });
}
const GAMES = {};
function gameCard(g) {
  const ps = g.players || [], inIt = ME && ps.some(p => p.uid === ME.uid), full = ps.length >= g.need;
  return `<button class="game" data-kc="game" data-gid="${esc(g.id)}">
    <div class="gd"><b>${new Date(g.when).toLocaleDateString([], { day: 'numeric' })}</b><span>${new Date(g.when).toLocaleDateString([], { month: 'short' })}</span></div>
    <div class="gi"><b>${esc(g.title)}</b><span class="meta">${new Date(g.when).toLocaleDateString([], { weekday: 'short' })} ${K.tm(g.when)} · ${esc(g.place)}</span>
    <span class="meta">${esc(g.format)} · ${esc(g.level)}${g.cost ? ' · ' + esc(g.cost) + ' each' : ''}</span>
    <span class="avrow sm">${ps.slice(0, 8).map(p => avatar(p.photo, p.name, 'av xs')).join('')}<span class="meta">${ps.length}/${g.need}${full ? ' · full' : ''}</span></span></div>
    ${inIt ? '<span class="tagok">In</span>' : ''}</button>`;
}
async function openNewGame() {
  {
    const d = new Date(); d.setDate(d.getDate() + 1);
    let turfs = []; try { turfs = (await getDocs(query(collection(db, 'turfs'), limit(100)))).docs.map(x => ({ id: x.id, ...x.data() })); } catch (e) {}
    K.openSheet('Organise a game', `<form class="form" data-kcform="newgame">
      <label>Title<input name="title" required maxlength="60" placeholder="Friday night 7s"></label>
      <label>Where<input name="place" required maxlength="80" list="turfopts" placeholder="Turf name or area"><datalist id="turfopts">${turfs.map(t => `<option value="${esc(t.name + ', ' + t.city)}">`).join('')}</datalist></label>
      <div class="two"><label>Date<input name="date" type="date" required value="${ymd(d)}"></label><label>Time<input name="time" type="time" required value="20:00"></label></div>
      <div class="two"><label>Format<select name="format"><option>5-a-side</option><option>6-a-side</option><option selected>7-a-side</option><option>9-a-side</option><option>11-a-side</option></select></label>
      <label>Players needed<input name="need" type="number" min="2" max="30" value="14"></label></div>
      <div class="two"><label>Level<select name="level"><option>Casual</option><option selected>Intermediate</option><option>Competitive</option></select></label>
      <label>Cost per player<input name="cost" maxlength="20" placeholder="e.g. AED 30"></label></div>
      <label>Notes<textarea name="notes" rows="3" maxlength="400" placeholder="Bring white and dark shirts…"></textarea></label>
      <button class="btn wide">Post game</button></form>`);
  }
}
async function createGame(f) {
  const v = Object.fromEntries(new FormData(f)); const u = me();
  const when = new Date(v.date + 'T' + v.time).getTime();
  if (when < Date.now()) return toast('Pick a time in the future');
  try {
    await addDoc(collection(db, 'games'), { title: v.title.trim(), place: v.place.trim(), when, format: v.format, need: +v.need || 10, level: v.level, cost: v.cost.trim(), notes: v.notes.trim(), uid: u.uid, host: u.name, hostPhoto: u.photo, players: [{ uid: u.uid, name: u.name, photo: u.photo }], createdAt: serverTimestamp() });
    toast('Game posted'); history.back();
  } catch (e) { toast('Couldn’t post: ' + (e.code || e.message)); }
}
function openGame(id) {
  const g = GAMES[id]; if (!g) return;
  const ps = g.players || [], inIt = ME && ps.some(p => p.uid === ME.uid), host = ME && g.uid === ME.uid;
  const txt = `⚽ ${g.title} — ${fmtDay(g.when)} ${K.tm(g.when)} at ${g.place}. ${g.format}, ${ps.length}/${g.need} in. Join on Kickoff: ${location.origin + location.pathname}`;
  K.openSheet(g.title, `<div class="card"><div class="meta">Hosted by ${esc(g.host)}</div><h2 class="cond" style="margin:4px 0">${esc(g.title)}</h2>
    <div>📅 ${fmtDay(g.when)} · ${K.tm(g.when)}</div><div>📍 ${esc(g.place)}</div><div>👟 ${esc(g.format)} · ${esc(g.level)}${g.cost ? ' · 💵 ' + esc(g.cost) + ' each' : ''}</div>${g.notes ? `<p class="ptext">${esc(g.notes)}</p>` : ''}
    <div class="acts" style="justify-content:flex-start">${host ? `<button class="btn ghost" data-kc="delgame" data-gid="${esc(id)}">Cancel game</button>` : `<button class="btn ${inIt ? 'ghost' : ''}" data-kc="joingame" data-gid="${esc(id)}">${inIt ? 'Leave' : ps.length >= g.need ? 'Join waitlist' : 'I’m in'}</button>`}
    <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">Share on WhatsApp</a></div></div>
    <div class="lg">Players (${ps.length}/${g.need})</div>${ps.map((p, i) => `<div class="cmt">${avatar(p.photo, p.name, 'av xs')}<div><b>${esc(p.name)}</b>${i === 0 ? ' <span class="meta">host</span>' : ''}${i >= g.need ? ' <span class="meta">waitlist</span>' : ''}</div></div>`).join('')}
    <div class="lg">Game chat</div><div id="gchat" class="chat"><div class="spin"></div></div>
    ${ME ? `<form class="chatbar" data-kcform="chat" data-path="games/${esc(id)}/msgs"><input maxlength="300" placeholder="Message players…" autocomplete="off"><button class="btn">Send</button></form>` : signInCard('Sign in to join and chat.')}`);
  mountChat('g' + id, 'games/' + id + '/msgs', '#gchat');
}
async function joinGame(id) {
  need('Sign in to join games.', async () => {
    const ref = doc(db, 'games', id), u = me();
    try {
      await runTransaction(db, async t => {
        const g = (await t.get(ref)).data(); const ps = g.players || [];
        const inIt = ps.some(p => p.uid === u.uid);
        t.update(ref, { players: inIt ? ps.filter(p => p.uid !== u.uid) : [...ps, { uid: u.uid, name: u.name, photo: u.photo }] });
        GAMES[id] = { ...g, id, players: inIt ? ps.filter(p => p.uid !== u.uid) : [...ps, { uid: u.uid, name: u.name, photo: u.photo }] };
      });
      openGame(id);
    } catch (e) { toast('Couldn’t update: ' + (e.code || e.message)); }
  });
}

/* ================= TURFS ================= */
const T = { q: '', list: [] };
const CUR_SYM = { AED: 'AED', INR: '₹', SAR: 'SAR', QAR: 'QAR', KWD: 'KWD', OMR: 'OMR', BHD: 'BHD', USD: '$', GBP: '£', EUR: '€' };
const money = (cur, v) => (CUR_SYM[cur] || cur || '') + (/^[A-Z]/.test(CUR_SYM[cur] || cur || '') ? ' ' : '') + Number(v || 0).toLocaleString();
function turfsBar() {
  return `<div class="tbar"><input id="tq" class="search" type="search" placeholder="Search turfs by name or city" value="${esc(T.q)}" autocomplete="off"><button class="btn" data-kc="newturf">＋ List</button></div>`;
}
async function renderTurfs() {
  if (!READY) { $('#view').innerHTML = '<div class="empty">Turf booking is being set up. Check back shortly.</div>'; return; }
  const q = $('#tq'); if (q && !q.dataset.b) { q.dataset.b = 1; q.addEventListener('input', () => { T.q = q.value; drawTurfs(); }); }
  let mineHtml = '';
  if (ME && OWNERB.length) mineHtml = `<button class="card alert" data-kc="mybookreqs">📅 <b>${OWNERB.length} booking request${OWNERB.length > 1 ? 's' : ''}</b> waiting for you</button>`;
  $('#view').innerHTML = mineHtml + '<div id="turfs"><div class="spin"></div></div>';
  try {
    const s = await getDocs(query(collection(db, 'turfs'), orderBy('createdAt', 'desc'), limit(200)));
    T.list = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.active !== false);
    drawTurfs();
  } catch (e) { $('#turfs').innerHTML = '<div class="empty">Couldn’t load turfs.</div>'; }
}
function drawTurfs() {
  const box = $('#turfs'); if (!box) return;
  const f = K.fold(T.q.trim());
  const list = T.list.filter(t => !f || K.fold(t.name + ' ' + t.city + ' ' + t.area).includes(f));
  box.innerHTML = list.length ? list.map(t => `<button class="turf" data-kc="turf" data-tid="${esc(t.id)}">
      <div class="tph">${t.photos?.[0] ? `<img src="${t.photos[0]}" alt="" loading="lazy">` : '<div class="tph0">⚽</div>'}${t.instant ? '<span class="chipi">Instant booking</span>' : ''}</div>
      <div class="tin"><b>${esc(t.name)}</b><span class="meta">📍 ${esc(t.area)}, ${esc(t.city)}</span>
      <span class="fm">${(t.formats || []).map(x => `<i>${esc(x)}</i>`).join('')}${t.surface ? `<i>${esc(t.surface)}</i>` : ''}</span>
      <span class="pr"><b>${money(t.currency, t.price)}</b> / hour</span></div></button>`).join('')
    : `<div class="empty">${T.list.length ? 'No turf matches that search.' : 'No turfs listed yet.<br><br>Own or manage a turf? Tap <b>＋ List</b> to take bookings on Kickoff.'}</div>`;
}
let TURF = null, TDAY = 0, TMODE = 'book';
async function openTurf(id, mode) {
  K.openSheet('Turf', '<div class="spin"></div>');
  const s = await getDoc(doc(db, 'turfs', id)).catch(() => null);
  if (!s?.exists()) return ($('#sheetBody').innerHTML = '<div class="empty">Turf not found.</div>');
  TURF = { id, ...s.data() }; TMODE = mode || 'book';
  drawTurf();
}
function drawTurf() {
  const t = TURF, owner = ME && t.ownerId === ME.uid;
  $('#sheetTitle').textContent = t.name;
  $('#sheetAct').innerHTML = owner ? `<button class="btn ghost" data-kc="editturf">Edit</button>` : '';
  const maps = t.mapLink || 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(t.name + ' ' + t.area + ' ' + t.city);
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  $('#sheetBody').innerHTML = `
    ${t.photos?.length ? `<div class="gallery">${t.photos.map(p => `<img src="${p}" alt="">`).join('')}</div>` : ''}
    <h2 class="cond tname">${esc(t.name)}</h2><div class="meta">📍 ${esc(t.area)}, ${esc(t.city)}</div>
    <div class="fm" style="margin:8px 0">${(t.formats || []).map(x => `<i>${esc(x)}</i>`).join('')}${t.surface ? `<i>${esc(t.surface)}</i>` : ''}</div>
    <div class="pr big"><b>${money(t.currency, t.price)}</b> / hour · open ${hhmm(t.open * 60)}–${hhmm(t.close * 60)}</div>
    <div class="acts" style="justify-content:flex-start"><a class="btn ghost" href="${esc(maps)}" target="_blank" rel="noopener">Directions</a><a class="btn ghost" href="${esc(wa(t.phone, 'Hi, I found ' + t.name + ' on Kickoff.'))}" target="_blank" rel="noopener">WhatsApp</a><a class="btn ghost" href="tel:${esc(t.phone)}">Call ${esc(t.phone)}</a></div>
    ${t.amenities?.length ? `<div class="amen">${t.amenities.map(a => `<span>✓ ${esc(a)}</span>`).join('')}</div>` : ''}
    ${t.desc ? `<p class="ptext">${esc(t.desc)}</p>` : ''}
    ${owner ? `<div class="seg2" style="margin-top:14px"><button class="${TMODE === 'book' ? 'on' : ''}" data-kc="tmode" data-mm="book">Player view</button><button class="${TMODE === 'manage' ? 'on' : ''}" data-kc="tmode" data-mm="manage">Manage bookings</button></div>` : ''}
    <div class="lg">${TMODE === 'manage' ? 'Bookings' : 'Pick a slot'}</div>
    <div class="chips dates">${days.map((d, i) => `<button class="chip ${TDAY === i ? 'on' : ''}" data-kc="tday" data-i="${i}">${i === 0 ? 'Today' : i === 1 ? 'Tmrw' : d.toLocaleDateString([], { weekday: 'short' })}<small>${d.getDate()} ${d.toLocaleDateString([], { month: 'short' })}</small></button>`).join('')}</div>
    <div id="slots"><div class="spin"></div></div>
    <div class="meta" style="margin-top:10px">${t.instant ? 'Bookings are confirmed instantly.' : 'The turf confirms each request — you’ll get a notification in the app.'} Pay at the venue.</div>`;
  watchSlots();
}
function slotList(t, day) {
  const out = [], len = t.slotMins || 60; let m = t.open * 60; const end = (t.close <= t.open ? t.close + 24 : t.close) * 60;
  for (; m + len <= end; m += len) { const d = new Date(day); d.setHours(0, 0, 0, 0); d.setMinutes(m); out.push({ key: hhmm(m).replace(':', ''), label: hhmm(m) + '–' + hhmm(m + len), start: d.getTime() }); }
  return out;
}
let SLOTSTATE = {};
function watchSlots() {
  unsub('slots');
  const day = new Date(); day.setDate(day.getDate() + TDAY); const date = ymd(day); const t = TURF;
  const owner = ME && t.ownerId === ME.uid;
  const q = owner && TMODE === 'manage'
    ? query(collection(db, 'bookings'), where('ownerId', '==', ME.uid), where('turfId', '==', t.id), where('date', '==', date))
    : query(collection(db, 'slots'), where('turfId', '==', t.id), where('date', '==', date));
  SUBS.slots = onSnapshot(q, s => {
    SLOTSTATE = {}; s.docs.forEach(d => { const x = d.data(); SLOTSTATE[x.slot] = { id: d.id, ...x }; });
    drawSlots(day, date, owner && TMODE === 'manage');
  }, e => { const b = $('#slots'); if (b) b.innerHTML = '<div class="meta">Couldn’t load slots.</div>'; });
}
function drawSlots(day, date, manage) {
  const box = $('#slots'); if (!box) return unsub('slots');
  const sl = slotList(TURF, day), now = Date.now();
  if (manage) {
    box.innerHTML = sl.map(s => {
      const b = SLOTSTATE[s.key], past = s.start < now; const st = b && b.status !== 'cancelled' && b.status !== 'declined' ? b.status : 'free';
      return `<div class="mslot ${st}"><span class="tm">${s.label}</span><span class="who">${b && st !== 'free' ? (b.status === 'blocked' ? '<b>Blocked</b>' : `<b>${esc(b.userName)}</b><span class="meta">${esc(b.format || '')}${b.contact ? ' · ' + esc(b.contact) : ''}${b.note ? ' · ' + esc(b.note) : ''}</span>`) : '<span class="meta">' + (past ? '—' : 'Free') + '</span>'}</span>
        <span class="mact">${st === 'pending' ? `<button class="mini ok" data-kc="bstatus" data-bid="${esc(b.id)}" data-s="confirmed">Confirm</button><button class="mini" data-kc="bstatus" data-bid="${esc(b.id)}" data-s="declined">Decline</button>` : ''}
        ${st === 'confirmed' ? `<span class="tagok">Confirmed</span>${b.contact ? `<a class="mini" href="${esc(wa(b.contact, 'Hi ' + b.userName + ', about your booking at ' + TURF.name + ' on ' + fmtDay(s.start) + ' ' + s.label))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}` : ''}
        ${st === 'free' && !past ? `<button class="mini" data-kc="block" data-slot="${s.key}" data-date="${date}">Block</button>` : ''}${st === 'blocked' ? `<button class="mini" data-kc="unblock" data-bid="${esc(b.id)}">Unblock</button>` : ''}</span></div>`;
    }).join('') || '<div class="meta">No slots — check opening hours.</div>';
    return;
  }
  box.innerHTML = `<div class="slots">${sl.map(s => {
    const b = SLOTSTATE[s.key], past = s.start < now, mine = ME && b?.userId === ME.uid && !['cancelled', 'declined'].includes(b.status);
    const taken = b && !['cancelled', 'declined'].includes(b.status);
    const cls = past ? 'past' : mine ? 'mine' : taken ? 'taken' : 'free';
    return `<button class="slot ${cls}" ${past || (taken && !mine) ? 'disabled' : ''} data-kc="${mine ? 'mybook' : 'pickslot'}" data-slot="${s.key}" data-label="${s.label}" data-start="${s.start}" data-date="${date}">${s.label}<small>${past ? '' : mine ? (b.status === 'pending' ? 'Requested' : 'Yours ✓') : taken ? (b.status === 'blocked' ? 'Closed' : 'Booked') : money(TURF.currency, TURF.price * (TURF.slotMins || 60) / 60)}</small></button>`;
  }).join('')}</div>`;
}
function pickSlot(d) {
  {
    const t = TURF;
    K.openSheet('Confirm booking', `<form class="form" data-kcform="book" data-slot="${esc(d.slot)}" data-date="${esc(d.date)}" data-start="${esc(d.start)}" data-label="${esc(d.label)}">
      <div class="card"><b>${esc(t.name)}</b><div>${fmtDay(+d.start)} · ${esc(d.label)}</div><div class="pr"><b>${money(t.currency, t.price * (t.slotMins || 60) / 60)}</b> · pay at the venue</div></div>
      ${(t.formats || []).length ? `<label>Format<select name="format">${t.formats.map(f => `<option>${esc(f)}</option>`).join('')}</select></label>` : ''}
      <label>Your phone / WhatsApp<input name="contact" type="tel" required value="${esc(PROFILE?.phone || '')}" placeholder="+971 50 000 0000"></label>
      <label>Note for the turf (optional)<input name="note" maxlength="120" placeholder="e.g. need bibs"></label>
      <button class="btn wide">${t.instant ? 'Book now' : 'Send booking request'}</button></form>`);
  }
}
async function book(f) {
  const v = Object.fromEntries(new FormData(f)), d = f.dataset, t = TURF, u = me();
  const id = t.id + '_' + d.date + '_' + d.slot, st = t.instant ? 'confirmed' : 'pending';
  const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Booking…';
  try {
    await runTransaction(db, async tr => {
      const sref = doc(db, 'slots', id), cur = await tr.get(sref);
      if (cur.exists() && !['cancelled', 'declined'].includes(cur.data().status)) throw new Error('taken');
      tr.set(sref, { turfId: t.id, ownerId: t.ownerId, date: d.date, slot: d.slot, status: st, userId: u.uid });
      tr.set(doc(db, 'bookings', id), { turfId: t.id, turfName: t.name, ownerId: t.ownerId, turfPhone: t.phone, date: d.date, slot: d.slot, label: d.label, start: +d.start, price: t.price * (t.slotMins || 60) / 60, currency: t.currency, format: v.format || '', contact: v.contact, note: v.note || '', userId: u.uid, userName: u.name, status: st, createdAt: serverTimestamp() });
    });
    if (v.contact && v.contact !== PROFILE?.phone) { updateDoc(doc(db, 'users', u.uid), { phone: v.contact }).catch(() => {}); PROFILE.phone = v.contact; }
    K.openSheet(st === 'confirmed' ? 'Booked!' : 'Request sent', `<div class="done"><div class="big">${st === 'confirmed' ? '✅' : '📨'}</div><h2 class="cond">${st === 'confirmed' ? 'You’re booked' : 'Request sent'}</h2>
      <p>${esc(t.name)}<br>${fmtDay(+d.start)} · ${esc(d.label)}</p><p class="meta">${st === 'confirmed' ? 'Pay at the venue. See you on the pitch!' : 'The turf will confirm shortly — you’ll see it in the app.'}</p>
      <div class="acts"><a class="btn" href="${esc(wa(t.phone, `Hi, I've ${st === 'confirmed' ? 'booked' : 'requested'} ${t.name} on ${fmtDay(+d.start)} ${d.label} via Kickoff. Name: ${u.name}`))}" target="_blank" rel="noopener">Message the turf</a>
      <a class="btn ghost" href="${esc(calLink(t.name, +d.start, (t.slotMins || 60), t.area + ', ' + t.city))}" target="_blank" rel="noopener">Add to calendar</a></div></div>`);
  } catch (e) { toast(e.message === 'taken' ? 'Sorry — someone just booked that slot' : 'Booking failed: ' + (e.code || e.message)); btn.disabled = false; btn.textContent = 'Try again'; }
}
function calLink(title, start, mins, where) {
  const f = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('⚽ ' + title) + '&dates=' + f(start) + '/' + f(start + mins * 60000) + '&location=' + encodeURIComponent(where);
}
async function setBookingStatus(id, status) {
  try {
    const b = writeBatch(db);
    b.update(doc(db, 'bookings', id), { status });
    b.update(doc(db, 'slots', id), { status });
    await b.commit(); toast(status === 'confirmed' ? 'Booking confirmed' : status === 'cancelled' ? 'Booking cancelled' : 'Booking declined');
  } catch (e) { toast('Couldn’t update: ' + (e.code || e.message)); }
}
async function blockSlot(date, slot) {
  const id = TURF.id + '_' + date + '_' + slot;
  try {
    const b = writeBatch(db);
    b.set(doc(db, 'slots', id), { turfId: TURF.id, ownerId: TURF.ownerId, date, slot, status: 'blocked', userId: ME.uid });
    b.set(doc(db, 'bookings', id), { turfId: TURF.id, turfName: TURF.name, ownerId: TURF.ownerId, date, slot, status: 'blocked', userId: ME.uid, userName: 'Blocked', createdAt: serverTimestamp() });
    await b.commit();
  } catch (e) { toast('Couldn’t block: ' + (e.code || e.message)); }
}
async function unblock(id) {
  try { const b = writeBatch(db); b.delete(doc(db, 'slots', id)); b.delete(doc(db, 'bookings', id)); await b.commit(); } catch (e) { toast('Couldn’t unblock'); }
}
let TPHOTOS = [];
function openTurfForm(edit) {
  {
    const t = edit ? TURF : { currency: 'AED', open: 6, close: 24, slotMins: 60, formats: ['5-a-side', '7-a-side'], amenities: ['Floodlights', 'Parking'], instant: false, surface: 'Artificial grass' };
    TPHOTOS = [...(t.photos || [])];
    const F = ['5-a-side', '6-a-side', '7-a-side', '9-a-side', '11-a-side'], A = ['Floodlights', 'Parking', 'Changing rooms', 'Showers', 'Drinking water', 'Bibs & balls', 'Café', 'Prayer room', 'Seating'];
    const hours = n => [...Array(25)].map((_, h) => `<option value="${h}" ${h === n ? 'selected' : ''}>${hhmm(h * 60)}</option>`).join('');
    K.openSheet(edit ? 'Edit turf' : 'List your turf', `<form class="form" data-kcform="saveturf" data-edit="${edit ? 1 : ''}">
      <label>Turf name<input name="name" required maxlength="60" value="${esc(t.name || '')}" placeholder="Green Arena"></label>
      <div class="two"><label>City<input name="city" required maxlength="40" value="${esc(t.city || '')}" placeholder="Dubai"></label><label>Area<input name="area" required maxlength="60" value="${esc(t.area || '')}" placeholder="Al Quoz"></label></div>
      <label>Google Maps link (optional)<input name="mapLink" type="url" value="${esc(t.mapLink || '')}" placeholder="https://maps.app.goo.gl/…"></label>
      <label>Phone / WhatsApp for bookings<input name="phone" type="tel" required value="${esc(t.phone || PROFILE?.phone || '')}" placeholder="+971 50 000 0000"></label>
      <div class="two"><label>Currency<select name="currency">${Object.keys(CUR_SYM).map(c => `<option ${c === t.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label>Price per hour<input name="price" type="number" min="0" required value="${esc(t.price ?? '')}" placeholder="250"></label></div>
      <div class="two"><label>Opens<select name="open">${hours(t.open)}</select></label><label>Closes<select name="close">${hours(t.close)}</select></label></div>
      <div class="two"><label>Slot length<select name="slotMins"><option value="60" ${t.slotMins == 60 ? 'selected' : ''}>1 hour</option><option value="90" ${t.slotMins == 90 ? 'selected' : ''}>1½ hours</option><option value="120" ${t.slotMins == 120 ? 'selected' : ''}>2 hours</option></select></label>
      <label>Surface<select name="surface">${['Artificial grass', 'Natural grass', 'Indoor', 'Futsal court', 'Sand'].map(x => `<option ${x === t.surface ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      <fieldset><legend>Formats</legend>${F.map(x => `<label class="ck"><input type="checkbox" name="formats" value="${x}" ${(t.formats || []).includes(x) ? 'checked' : ''}>${x}</label>`).join('')}</fieldset>
      <fieldset><legend>Facilities</legend>${A.map(x => `<label class="ck"><input type="checkbox" name="amenities" value="${x}" ${(t.amenities || []).includes(x) ? 'checked' : ''}>${x}</label>`).join('')}</fieldset>
      <label class="ck big"><input type="checkbox" name="instant" ${t.instant ? 'checked' : ''}> Confirm bookings instantly (otherwise you approve each request)</label>
      <label>About the turf<textarea name="desc" rows="3" maxlength="600" placeholder="Size, rules, offers…">${esc(t.desc || '')}</textarea></label>
      <div class="lg" style="margin-top:4px">Photos (up to 4)</div><div id="tph" class="thumbs"></div><label class="btn ghost">＋ Add photos<input type="file" accept="image/*" multiple id="tfile" hidden></label>
      ${edit ? `<label class="ck"><input type="checkbox" name="hidden" ${t.active === false ? 'checked' : ''}> Hide this turf from the listings</label>` : ''}
      <button class="btn wide">${edit ? 'Save changes' : 'Publish turf'}</button></form>`);
    const draw = () => { $('#tph').innerHTML = TPHOTOS.map((p, i) => `<span><img src="${p}" alt=""><button type="button" data-kc="rmph" data-i="${i}">×</button></span>`).join(''); };
    draw(); TPHOTOS.draw = draw;
    $('#tfile').onchange = async e => { for (const f of [...e.target.files].slice(0, 4 - TPHOTOS.length)) TPHOTOS.push(await compress(f, 800, 0.55, 190000)); draw(); };
  }
}
async function saveTurf(f) {
  const fd = new FormData(f), v = Object.fromEntries(fd);
  const data = { name: v.name.trim(), city: v.city.trim(), area: v.area.trim(), mapLink: v.mapLink.trim(), phone: v.phone.trim(), currency: v.currency, price: +v.price || 0, open: +v.open, close: +v.close, slotMins: +v.slotMins, surface: v.surface,
    formats: fd.getAll('formats'), amenities: fd.getAll('amenities'), instant: !!v.instant, desc: v.desc.trim(), photos: TPHOTOS.slice(0, 4), active: !v.hidden };
  if (data.close === data.open) return toast('Opening and closing times can’t be the same');
  const btn = f.querySelector('button:last-of-type'); btn.disabled = true;
  try {
    if (f.dataset.edit) { await updateDoc(doc(db, 'turfs', TURF.id), data); TURF = { ...TURF, ...data }; toast('Saved'); history.back(); }
    else { const r = await addDoc(collection(db, 'turfs'), { ...data, ownerId: ME.uid, ownerName: me().name, createdAt: serverTimestamp() }); toast('Your turf is live!'); history.back(); setTimeout(() => K.pushSheet('turf' + r.id, () => openTurf(r.id, 'manage')), 350); }
  } catch (e) { toast('Couldn’t save: ' + (e.code || e.message)); btn.disabled = false; }
}

/* ================= ME (profile, bookings, my turfs) ================= */
async function renderMe(box) {
  if (!box) return;
  if (!READY) { box.innerHTML = ''; return; }
  if (!ME) { box.innerHTML = signInCard('Your profile, fan clubs, predictions, games and turf bookings — all in one place.'); return; }
  const p = PROFILE || {};
  box.innerHTML = `<div class="profile">${avatar(p.photo || ME.photoURL, p.name, 'av lg')}<div><h2 class="cond">${esc(p.name || ME.displayName)}</h2>
    <div class="meta">${[p.position, p.city].filter(Boolean).map(esc).join(' · ') || 'Add your city and position'}</div>
    ${p.team ? `<div class="meta" style="display:flex;align-items:center;gap:5px"><img class="crest sm" src="${esc(p.team.logo)}" alt="">${esc(p.team.name)} fan</div>` : ''}</div>
    <button class="mini" data-kc="editprofile" style="margin-left:auto">Edit</button></div>
    <div id="mybooks"></div><div id="myturfs"></div>`;
  const now = Date.now();
  const up = MYB.filter(b => b.start > now - 3600e3 && !['cancelled', 'declined', 'blocked'].includes(b.status)).sort((a, b) => a.start - b.start);
  if (up.length) $('#mybooks').innerHTML = `<div class="lg">My bookings</div>` + up.map(b => `<div class="bk"><div><b>${esc(b.turfName)}</b><div class="meta">${fmtDay(b.start)} · ${esc(b.label)} · ${money(b.currency, b.price)}</div></div><span class="st ${b.status}">${b.status === 'pending' ? 'Awaiting turf' : 'Confirmed'}</span>
    <div class="bka"><button class="mini" data-kc="turf" data-tid="${esc(b.turfId)}">View turf</button>${b.turfPhone ? `<a class="mini" href="${esc(wa(b.turfPhone, 'Hi, about my Kickoff booking on ' + fmtDay(b.start) + ' ' + b.label))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button class="mini" data-kc="cancelbook" data-bid="${esc(b.id)}">Cancel</button></div></div>`).join('');
  try {
    const s = await getDocs(query(collection(db, 'turfs'), where('ownerId', '==', ME.uid)));
    if (s.docs.length && $('#myturfs')) $('#myturfs').innerHTML = `<div class="lg">My turfs</div>` + s.docs.map(d => { const t = d.data(); const n = OWNERB.filter(b => b.turfId === d.id).length;
      return `<button class="row" data-kc="turf" data-tid="${esc(d.id)}" data-mode="manage">${t.photos?.[0] ? `<img src="${t.photos[0]}" alt="" style="border-radius:8px;object-fit:cover">` : '<span class="av ini">⚽</span>'}<div><b>${esc(t.name)}</b><div class="meta">${esc(t.area)}, ${esc(t.city)}${t.active === false ? ' · hidden' : ''}</div></div>${n ? `<span class="badge static">${n}</span>` : ''}<span style="margin-left:auto;color:var(--mute)">Manage ›</span></button>`; }).join('');
  } catch (e) {}
}
function openProfile() {
  const p = PROFILE || {};
  K.openSheet('Edit profile', `<form class="form" data-kcform="profile">
    <label>Display name<input name="name" required maxlength="40" value="${esc(p.name || '')}"></label>
    <div class="two"><label>City<input name="city" maxlength="40" value="${esc(p.city || '')}" placeholder="Dubai"></label>
    <label>Position<select name="position">${['', 'Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'All-rounder'].map(x => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
    <label>Phone / WhatsApp (used for bookings)<input name="phone" type="tel" maxlength="20" value="${esc(p.phone || '')}"></label>
    <label>Favourite team<select name="team"><option value="">—</option>${K.S.favs.map(f => `<option value="${esc(f.id)}" ${p.team?.id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select><span class="meta">Teams you follow appear here. Your team’s crest shows next to your name.</span></label>
    <label>Bio<textarea name="bio" rows="2" maxlength="160">${esc(p.bio || '')}</textarea></label>
    <button class="btn wide">Save</button>
    <button type="button" class="btn ghost wide" data-kc="logout" style="margin-top:8px">Sign out</button></form>`);
}
async function saveProfile(f) {
  const v = Object.fromEntries(new FormData(f));
  const fav = K.S.favs.find(x => String(x.id) === v.team);
  const data = { name: v.name.trim(), city: v.city.trim(), position: v.position, phone: v.phone.trim(), bio: v.bio.trim(), team: fav ? { id: String(fav.id), name: fav.name, logo: fav.logo } : null };
  try { await updateDoc(doc(db, 'users', ME.uid), data); PROFILE = { ...PROFILE, ...data }; updateAvatar(); toast('Profile saved'); history.back(); }
  catch (e) { toast('Couldn’t save: ' + (e.code || e.message)); }
}

/* ================= events ================= */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-kc],[data-kcv]'); if (!b) return;
  if (b.dataset.kcv) { C.view = b.dataset.kcv; $('#subbar').innerHTML = fansBar(); renderFans(); return; }
  const d = b.dataset, a = d.kc;
  if (b.tagName === 'A' && a) e.preventDefault();
  const push = (k, fn) => K.pushSheet(k, fn);
  ({
    login: () => login(),
    logout: () => { signOut(auth); history.back(); toast('Signed out'); },
    compose: () => need('Sign in to post.', () => push('compose', () => openCompose(d.club, d.clubname))),
    publish: () => publish(b),
    like: () => toggleLike(d.pid),
    post: () => push('post' + d.pid, () => openPost(d.pid)),
    sharepost: () => { const p = POSTS[d.pid]; K.shareText((p?.name || '') + ' on Kickoff: ' + (p?.text || '')); },
    delpost: () => { if (confirmTap(b, 'dp' + d.pid)) deleteDoc(doc(db, 'posts', d.pid)).then(() => toast('Deleted')).catch(() => toast('Couldn’t delete')); },
    findclub: () => push('search', () => K.openSearch('club')),
    club: () => push('club' + d.club, () => openClub(d.club)),
    joinclub: () => toggleClub(d.club, b),
    pstep: () => { const el = $('#p' + d.t); el.textContent = Math.max(0, Math.min(15, +el.textContent + +d.d)); },
    savepred: () => savePred(b),
    newgame: () => need('Sign in to organise a game.', () => push('newgame', openNewGame)),
    game: () => push('game' + d.gid, () => openGame(d.gid)),
    joingame: () => joinGame(d.gid),
    delgame: () => { if (confirmTap(b, 'dg' + d.gid)) deleteDoc(doc(db, 'games', d.gid)).then(() => { toast('Game cancelled'); history.back(); }).catch(() => toast('Couldn’t cancel')); },
    newturf: () => need('Sign in to list your turf.', () => push('newturf', () => openTurfForm(false))),
    editturf: () => push('editturf', () => openTurfForm(true)),
    turf: () => push('turf' + d.tid, () => openTurf(d.tid, d.mode)),
    tday: () => { TDAY = +d.i; drawTurf(); },
    tmode: () => { TMODE = d.mm; drawTurf(); },
    pickslot: () => { const dd = { ...d }; need('Sign in to book a slot.', () => push('slot', () => pickSlot(dd))); },
    mybook: () => toast('This slot is yours — manage it from your profile'),
    bstatus: () => setBookingStatus(d.bid, d.s),
    block: () => blockSlot(d.date, d.slot),
    unblock: () => unblock(d.bid),
    cancelbook: () => { if (confirmTap(b, 'cb' + d.bid, 'Tap again to cancel')) setBookingStatus(d.bid, 'cancelled').then(() => { MYB = MYB.map(x => x.id === d.bid ? { ...x, status: 'cancelled' } : x); renderMe($('#meTop')); }); },
    mybookreqs: async () => { const id = OWNERB[0]?.turfId; if (id) { const s = OWNERB[0]; const i = Math.round((new Date(s.date + 'T00:00') - new Date(ymd(Date.now()) + 'T00:00')) / 864e5); TDAY = Math.max(0, Math.min(13, i)); push('turf' + id, () => openTurf(id, 'manage')); } },
    rmph: () => { TPHOTOS.splice(+d.i, 1); TPHOTOS.draw?.(); },
    editprofile: () => push('profile', openProfile),
  })[a]?.();
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-kcform]'); if (!f) return; e.preventDefault();
  const k = f.dataset.kcform;
  if (!ME) return need('Sign in first.', () => {});
  if (k === 'chat') sendChat(f.dataset.path, f.querySelector('input'));
  if (k === 'comment') addComment(f.dataset.pid, f.querySelector('input'));
  if (k === 'newgame') createGame(f);
  if (k === 'book') book(f);
  if (k === 'saveturf') saveTurf(f);
  if (k === 'profile') saveProfile(f);
});

window.KC = { ready: READY, fansBar, renderFans, turfsBar, renderTurfs, renderMe, matchPane, mountMatch, toggleClub, openClub, stop: () => ['v_feed', 'v_play', 'chat', 'slots', 'club', 'cmts'].forEach(unsub), stopSheet: () => ['chat', 'slots', 'club', 'cmts'].forEach(unsub), user: () => ME };
updateAvatar();
window.dispatchEvent(new Event('kc-ready'));
