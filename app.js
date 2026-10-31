/* ============ App version (shown in the small badge, bottom-right) ============
   Bump this on every deploy alongside CACHE_VERSION in service-worker.js —
   they're independent strings in separate files, nothing keeps them in sync
   automatically. This one is just for you to visually confirm you're on the
   latest build; it has no effect on caching. */
const APP_VERSION = 'v8.37';
const APP_VERSION_DATE = '2026-10-31';
(function initVersionBadge(){
  const el = document.getElementById('versionBadge');
  if(el) el.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;
  const lv = document.getElementById('lockVersion');
  if(lv) lv.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;
})();

/* ============ App lock (PBKDF2 + AES-GCM via Web Crypto) ============ */
const LOCK_STORE_KEY = 'family-tree-lock-v1'; // holds only salt + a verifier, never the passcode itself
const PBKDF2_ITERATIONS = 210000;
let sessionKey = null; // in-memory CryptoKey for this session only — never persisted anywhere

function bytesToBase64(bytes){
  let binary = '';
  const arr = new Uint8Array(bytes);
  for(let i=0;i<arr.length;i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}
function base64ToBytes(b64){
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) arr[i] = binary.charCodeAt(i);
  return arr;
}
async function deriveKeyFromPasscode(passcode, saltBytes){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash:'SHA-256' },
    baseKey,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}
async function encryptJSON(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, data);
  return { iv: bytesToBase64(iv), data: bytesToBase64(cipherBuf) };
}
async function decryptJSON(key, packet){
  const iv = base64ToBytes(packet.iv);
  const cipherBytes = base64ToBytes(packet.data);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, cipherBytes);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}
async function encryptBytes(key, bytes){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, bytes);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return combined;
}
async function decryptBytes(key, combined){
  const iv = combined.slice(0,12);
  const cipherBytes = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, cipherBytes);
  return new Uint8Array(plainBuf);
}
async function loadLockMeta(){
  try{
    if(hasClaudeStorage){
      const res = await window.storage.get(LOCK_STORE_KEY, false);
      return res && res.value ? JSON.parse(res.value) : null;
    } else {
      const stored = localStorage.getItem(LOCK_STORE_KEY);
      return stored ? JSON.parse(stored) : null;
    }
  }catch(e){ return null; }
}
async function saveLockMeta(meta){
  const json = JSON.stringify(meta);
  try{
    if(hasClaudeStorage){ await window.storage.set(LOCK_STORE_KEY, json, false); }
    else{ localStorage.setItem(LOCK_STORE_KEY, json); }
  }catch(e){ console.error('保存密码设置失败', e); }
}
async function clearLockMeta(){
  try{
    if(hasClaudeStorage){ await window.storage.delete(LOCK_STORE_KEY, false); }
    else{ localStorage.removeItem(LOCK_STORE_KEY); }
  }catch(e){}
}
async function setupPasscode(passcode){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPasscode(passcode, salt);
  const verifier = await encryptJSON(key, { check:'family-tree-unlock-ok' });
  await saveLockMeta({ salt: bytesToBase64(salt), verifier });
  sessionKey = key;
}
async function tryUnlock(passcode, meta){
  try{
    const salt = base64ToBytes(meta.salt);
    const key = await deriveKeyFromPasscode(passcode, salt);
    const result = await decryptJSON(key, meta.verifier);
    if(result && result.check==='family-tree-unlock-ok'){
      sessionKey = key;
      return true;
    }
  }catch(e){ /* wrong passcode -> decrypt throws */ }
  return false;
}
async function changePasscode(oldPass, newPass){
  const meta = await loadLockMeta();
  if(!meta) throw new Error('尚未设置密码');
  const oldSalt = base64ToBytes(meta.salt);
  const oldKey = await deriveKeyFromPasscode(oldPass, oldSalt);
  let check = null;
  try{ check = await decryptJSON(oldKey, meta.verifier); }catch(e){}
  if(!check || check.check!=='family-tree-unlock-ok') throw new Error('当前密码不正确');

  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await deriveKeyFromPasscode(newPass, newSalt);

  // re-encrypt every stored photo with the new key
  const entries = await getAllPhotoEntries();
  for(const [id, storedBlob] of entries){
    try{
      const bytes = new Uint8Array(await storedBlob.arrayBuffer());
      let plainBytes;
      try{
        plainBytes = await decryptBytes(oldKey, bytes);
      }catch(e){
        plainBytes = bytes; // legacy plaintext photo, never encrypted
      }
      const reEncrypted = await encryptBytes(newKey, plainBytes);
      await putPhotoBlobRaw(id, new Blob([reEncrypted]));
    }catch(e){ console.error('重新加密照片失败', id, e); }
  }

  sessionKey = newKey;
  const verifier = await encryptJSON(newKey, { check:'family-tree-unlock-ok' });
  await saveLockMeta({ salt: bytesToBase64(newSalt), verifier });
  saveData(); // re-encrypts people/trees with the new key
}

/* ============ Storage abstraction ============ */
const STORE_KEY = 'family-tree-people-v1';
const hasClaudeStorage = (typeof window.storage !== 'undefined' && window.storage !== null);
const DEFAULT_TREES = [{id:'main', name:'我的家族'}];

function normalizeLoadedPayload(raw){
  if(!raw) return { people: [], trees: DEFAULT_TREES.slice(), currentTreeId: 'main' };
  if(Array.isArray(raw)){
    // legacy format from before multi-tree support: a plain people array
    return { people: raw, trees: DEFAULT_TREES.slice(), currentTreeId: 'main' };
  }
  return {
    people: raw.people || [],
    trees: (raw.trees && raw.trees.length) ? raw.trees : DEFAULT_TREES.slice(),
    currentTreeId: raw.currentTreeId || (raw.trees && raw.trees[0] && raw.trees[0].id) || 'main'
  };
}

async function loadData(){
  let raw = null;
  try{
    if(hasClaudeStorage){
      const res = await window.storage.get(STORE_KEY, false);
      raw = res && res.value ? JSON.parse(res.value) : null;
    } else {
      const stored = localStorage.getItem(STORE_KEY);
      raw = stored ? JSON.parse(stored) : null;
    }
  }catch(e){ raw = null; }

  if(!raw) return normalizeLoadedPayload(null);

  if(raw.__encrypted){
    if(!sessionKey) throw new Error('数据已加密，但没有可用的解锁密钥');
    const decrypted = await decryptJSON(sessionKey, raw);
    return normalizeLoadedPayload(decrypted);
  }
  // legacy plaintext data from before the app-lock feature existed
  return normalizeLoadedPayload(raw);
}
let saveTimer=null;
function saveData(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async ()=>{
    const payload = { people, trees, currentTreeId };
    let toStore;
    try{
      if(sessionKey){
        const enc = await encryptJSON(sessionKey, payload);
        toStore = JSON.stringify({ __encrypted:true, iv:enc.iv, data:enc.data });
      } else {
        toStore = JSON.stringify(payload);
      }
    }catch(e){ console.error('加密失败', e); return; }
    try{
      if(hasClaudeStorage){ await window.storage.set(STORE_KEY, toStore, false); }
      else{ localStorage.setItem(STORE_KEY, toStore); }
    }catch(e){ console.error('保存失败', e); }
  }, 250);
}

/* ============ Country coordinates (approximate centroids, for the map view) ============ */
const COUNTRY_COORDS = {
  '中国':{lat:35,lng:105,iso:'cn'}, '香港':{lat:22.3,lng:114.2,iso:null}, '澳门':{lat:22.2,lng:113.5,iso:null}, '台湾':{lat:23.7,lng:121,iso:'tw'},
  '马来西亚':{lat:4,lng:102,iso:'my'}, '新加坡':{lat:1.35,lng:103.8,iso:'sg'}, '印度尼西亚':{lat:-0.8,lng:113.9,iso:'id'}, '泰国':{lat:15,lng:101,iso:'th'},
  '菲律宾':{lat:12.9,lng:121.8,iso:'ph'}, '越南':{lat:16,lng:107.8,iso:'vn'}, '缅甸':{lat:21.9,lng:96,iso:'mm'}, '柬埔寨':{lat:12.6,lng:105,iso:'kh'},
  '老挝':{lat:19.9,lng:102.6,iso:'la'}, '文莱':{lat:4.5,lng:114.7,iso:'bn'}, '日本':{lat:36.2,lng:138.3,iso:'jp'}, '韩国':{lat:36.5,lng:127.8,iso:'kr'},
  '朝鲜':{lat:40.3,lng:127.5,iso:'kp'}, '蒙古':{lat:46.9,lng:103.8,iso:'mn'}, '印度':{lat:22,lng:79,iso:'in'}, '巴基斯坦':{lat:30,lng:70,iso:'pk'},
  '孟加拉':{lat:23.7,lng:90.4,iso:'bd'}, '斯里兰卡':{lat:7.9,lng:80.8,iso:'lk'}, '尼泊尔':{lat:28.4,lng:84.1,iso:'np'},
  '澳大利亚':{lat:-25.3,lng:133.8,iso:'au'}, '新西兰':{lat:-41,lng:174,iso:'nz'},
  '美国':{lat:39.8,lng:-98.6,iso:'us'}, '加拿大':{lat:56.1,lng:-106.3,iso:'ca'}, '墨西哥':{lat:23.6,lng:-102.5,iso:'mx'},
  '巴西':{lat:-10,lng:-52,iso:'br'}, '阿根廷':{lat:-34,lng:-64,iso:'ar'}, '智利':{lat:-35.7,lng:-71.5,iso:'cl'}, '秘鲁':{lat:-9.2,lng:-75,iso:'pe'},
  '哥伦比亚':{lat:4.6,lng:-74.3,iso:'co'}, '委内瑞拉':{lat:8,lng:-66,iso:'ve'},
  '英国':{lat:54,lng:-2,iso:'gb'}, '爱尔兰':{lat:53.4,lng:-8,iso:'ie'}, '法国':{lat:46.6,lng:2.2,iso:'fr'}, '德国':{lat:51.2,lng:10.4,iso:'de'},
  '荷兰':{lat:52.1,lng:5.3,iso:'nl'}, '比利时':{lat:50.5,lng:4.5,iso:'be'}, '瑞士':{lat:46.8,lng:8.2,iso:'ch'}, '意大利':{lat:42.8,lng:12.8,iso:'it'},
  '西班牙':{lat:40,lng:-3.7,iso:'es'}, '葡萄牙':{lat:39.4,lng:-8,iso:'pt'}, '瑞典':{lat:60.1,lng:18.6,iso:'se'}, '挪威':{lat:60.5,lng:8.5,iso:'no'},
  '丹麦':{lat:56.3,lng:9.5,iso:'dk'}, '芬兰':{lat:61.9,lng:25.7,iso:'fi'}, '波兰':{lat:51.9,lng:19.1,iso:'pl'}, '俄罗斯':{lat:61.5,lng:105.3,iso:'ru'},
  '乌克兰':{lat:48.4,lng:31.2,iso:'ua'}, '希腊':{lat:39.1,lng:21.8,iso:'gr'}, '奥地利':{lat:47.5,lng:14.6,iso:'at'}, '捷克':{lat:49.8,lng:15.5,iso:'cz'},
  '土耳其':{lat:38.9,lng:35.2,iso:'tr'},
  '沙特阿拉伯':{lat:24,lng:45,iso:'sa'}, '阿联酋':{lat:24,lng:54,iso:'ae'}, '卡塔尔':{lat:25.3,lng:51.2,iso:'qa'}, '以色列':{lat:31,lng:35,iso:'il'},
  '埃及':{lat:26.8,lng:30.8,iso:'eg'}, '南非':{lat:-29,lng:24.7,iso:'za'}, '尼日利亚':{lat:9.1,lng:8.7,iso:'ng'}, '肯尼亚':{lat:-0.02,lng:37.9,iso:'ke'},
};
const COUNTRY_ALIASES = {
  'china':'中国','malaysia':'马来西亚','singapore':'新加坡','indonesia':'印度尼西亚','thailand':'泰国',
  'philippines':'菲律宾','vietnam':'越南','myanmar':'缅甸','cambodia':'柬埔寨','laos':'老挝','brunei':'文莱',
  'japan':'日本','south korea':'韩国','korea':'韩国','mongolia':'蒙古','india':'印度','pakistan':'巴基斯坦',
  'bangladesh':'孟加拉','sri lanka':'斯里兰卡','nepal':'尼泊尔','australia':'澳大利亚','new zealand':'新西兰',
  'usa':'美国','united states':'美国','us':'美国','america':'美国','canada':'加拿大','mexico':'墨西哥',
  'brazil':'巴西','argentina':'阿根廷','chile':'智利','peru':'秘鲁','colombia':'哥伦比亚','venezuela':'委内瑞拉',
  'uk':'英国','united kingdom':'英国','britain':'英国','england':'英国','ireland':'爱尔兰','france':'法国',
  'germany':'德国','netherlands':'荷兰','belgium':'比利时','switzerland':'瑞士','italy':'意大利','spain':'西班牙',
  'portugal':'葡萄牙','sweden':'瑞典','norway':'挪威','denmark':'丹麦','finland':'芬兰','poland':'波兰',
  'russia':'俄罗斯','ukraine':'乌克兰','greece':'希腊','austria':'奥地利','czech republic':'捷克','turkey':'土耳其',
  'saudi arabia':'沙特阿拉伯','uae':'阿联酋','qatar':'卡塔尔','israel':'以色列','egypt':'埃及','south africa':'南非',
  'nigeria':'尼日利亚','kenya':'肯尼亚','hong kong':'香港','macau':'澳门','taiwan':'台湾',
};
function lookupCountryCoords(name){
  if(!name) return null;
  const trimmed = name.trim();
  if(COUNTRY_COORDS[trimmed]) return {name:trimmed, ...COUNTRY_COORDS[trimmed]};
  const alias = COUNTRY_ALIASES[trimmed.toLowerCase()];
  if(alias && COUNTRY_COORDS[alias]) return {name:alias, ...COUNTRY_COORDS[alias]};
  return null;
}

/* ============ State ============ */
let people = [];
let trees = DEFAULT_TREES.slice();
let currentTreeId = 'main';
let selectedId = null;
let dragState = null; // active pointer-based drag-to-reorder state
let undoStack = [];
const MAX_UNDO = 30;
function pushHistory(){
  try{
    undoStack.push(JSON.stringify({people, trees, currentTreeId}));
    if(undoStack.length>MAX_UNDO) undoStack.shift();
  }catch(e){}
  updateUndoButton();
}
function undo(){
  if(undoStack.length===0){ toast('没有可撤销的操作了'); return; }
  const snapshot = JSON.parse(undoStack.pop());
  people = snapshot.people;
  trees = snapshot.trees;
  currentTreeId = snapshot.currentTreeId;
  selectedId = null;
  focusPersonId = null;
  saveData();
  renderTreeSelect();
  render();
  renderSidePanel();
  updateUndoButton();
  toast('已撤销上一步操作');
}
function updateUndoButton(){
  const btn = document.getElementById('undoBtn');
  if(btn) btn.disabled = undoStack.length===0;
}
let editingId = null;
let zoom = 1;
let pan = {x:0, y:0};
let panState = null;
let lastColumnIndex = {}; // id -> {level, col} snapshot from the most recent render, used to
                          // decide whether two parents sit adjacent to each other on screen
let compactView = true;   // icon-style view (circle avatars + marriage dots); toggle via topbar button
try{ const v = localStorage.getItem('ft_compact_view'); if(v==='0') compactView = false; }catch(e){}
document.body.classList.toggle('compact-view', compactView);
let panelOpen = false;    // detail panel only shows when explicitly opened (via the 'i' button)
let focusPersonId = null; // when set, only this person's family (within the gen limits below) shows
let focusUpGen = 2;       // how many generations of ancestors to include
let focusDownGen = 2;     // how many generations of descendants to include
let currentFocusSet = null; // recomputed each render() from the above

function uid(){ return 'p_' + Math.random().toString(36).slice(2,10); }

function personById(id){ return people.find(p=>p.id===id); }
function childrenOf(id){
  return people.filter(p => p.parents && p.parents.includes(id));
}
function findCardEl(root, id){
  // Looks up a rendered person card by id via dataset comparison rather than
  // building a CSS attribute-selector string (`.card[data-id="'+id+'"]'`).
  // Ids are internally generated, but imported ZIP data isn't schema-validated,
  // so a crafted id containing a `"` could otherwise break the selector.
  if(!root) return null;
  const cards = root.querySelectorAll('.card');
  for(const el of cards){ if(el.dataset.id === id) return el; }
  return null;
}
function initials(name){
  if(!name) return '?';
  const parts = name.trim().split(/\s+/);
  const raw = parts.length===1 ? parts[0].slice(0,1) : parts[0].slice(0,1)+parts[parts.length-1].slice(0,1);
  // Always escaped at the source: initials() is interpolated directly into
  // innerHTML at several call sites, so it must never depend on callers
  // remembering to wrap it themselves.
  return escapeHtml(raw);
}
const ORDER_CN = ['','长','次','三','四','五','六','七','八','九','十'];
function birthOrderLabel(p){
  const n = parseInt(p && p.birthOrder, 10);
  if(!n || n<1) return '';
  const head = n<=10 ? ORDER_CN[n] : '第'+n;
  if(p.gender==='M') return head + '子';
  if(p.gender==='F') return head + '女';
  return '排行第' + n;
}
function yearsLabel(p){
  if(!p.birth && !p.death) return '';
  const base = (p.birth||'?') + ' – ' + (p.death||'今');
  const b = parseInt(p.birth, 10), d = parseInt(p.death, 10);
  if(p.birth && p.death && !isNaN(b) && !isNaN(d) && d>=b){
    return `${base}（享年${d-b}岁）`;
  }
  return base;
}

// v8.7: compact-view helpers. surnameChar() = first character of the name
// (the surname for Chinese names), shown inside the avatar circle when no
// photo is set. lifespanShort() = '1938–2015' for the line under the name.
function surnameChar(name){
  const t = (name||'').trim();
  if(!t) return '?';
  return escapeHtml(Array.from(t)[0].toUpperCase());
}
function lifespanShort(p){
  const b = (p.birth||'').toString().trim(), d = (p.death||'').toString().trim();
  if(!b && !d) return '';
  return (b||'?') + '–' + d;
}
function isDeceased(p){ return !!((p.death||'').toString().trim()); }

/* ============ Image resize ============ */
function resizeImageToBlob(file, maxDim=220){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let w=img.width, h=img.height;
        if(w>h){ if(w>maxDim){ h*=maxDim/w; w=maxDim; } }
        else{ if(h>maxDim){ w*=maxDim/h; h=maxDim; } }
        const canvas = document.createElement('canvas');
        canvas.width=w; canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        canvas.toBlob(blob=>{
          if(blob) resolve(blob); else reject(new Error('生成图片失败'));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ============ Photo storage (IndexedDB) ============ */
// Photos live in IndexedDB (not localStorage/window.storage) since they're
// binary and can be large — localStorage/window.storage have tiny (5-10MB)
// quotas that base64 photos would blow through fast. Only a small photoId
// reference is kept on each person in the regular JSON data.
const PHOTO_DB_NAME = 'family-tree-photos-db';
const PHOTO_STORE = 'photos';
let photoDBPromise = null;
function openPhotoDB(){
  if(photoDBPromise) return photoDBPromise;
  photoDBPromise = new Promise((resolve, reject)=>{
    if(typeof indexedDB==='undefined'){ reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
  return photoDBPromise;
}
async function putPhotoBlobRaw(photoId, blob){
  const db = await openPhotoDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).put(blob, photoId);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
async function getPhotoBlobRaw(photoId){
  const db = await openPhotoDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const req = tx.objectStore(PHOTO_STORE).get(photoId);
    req.onsuccess = ()=>resolve(req.result || null);
    req.onerror = ()=>reject(req.error);
  });
}
async function putPhotoBlob(photoId, blob){
  if(!sessionKey) return putPhotoBlobRaw(photoId, blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encryptedBytes = await encryptBytes(sessionKey, bytes);
  return putPhotoBlobRaw(photoId, new Blob([encryptedBytes]));
}
async function getPhotoBlob(photoId){
  const storedBlob = await getPhotoBlobRaw(photoId);
  if(!storedBlob) return null;
  if(!sessionKey) return storedBlob;
  const bytes = new Uint8Array(await storedBlob.arrayBuffer());
  try{
    const decryptedBytes = await decryptBytes(sessionKey, bytes);
    return new Blob([decryptedBytes], {type:'image/jpeg'});
  }catch(e){
    // Not decryptable with the current key — this is expected for photos
    // saved before the app-lock feature existed (still plain, unencrypted
    // blobs). Use it as-is, then quietly re-save it encrypted so future
    // reads go through the normal encrypted path.
    putPhotoBlob(photoId, storedBlob).catch(()=>{});
    return storedBlob;
  }
}
async function deletePhotoBlob(photoId){
  const db = await openPhotoDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).delete(photoId);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
// Discards a single photo's blob + cached object URL. Only safe to call once
// you're sure NOTHING could still reference this photoId — including undo
// history, which is why nothing calls this directly for a specific id; see
// gcOrphanedPhotos() below, which is the actual entry point used elsewhere.
async function purgePhoto(photoId){
  if(!photoId) return;
  const url = photoCache[photoId];
  if(url) URL.revokeObjectURL(url);
  delete photoCache[photoId];
  try{ await deletePhotoBlob(photoId); }catch(e){ console.error('清理旧照片失败', photoId, e); }
}
// Sweeps IndexedDB for photo blobs that nothing can reach anymore, and
// removes them. "Reachable" means referenced by any current person's
// photoId, OR present in any undo-stack snapshot (people who could come
// back via Ctrl+Z) — so a photo is only ever swept once undo could no
// longer possibly restore whoever it belonged to. This runs as a best-effort
// background pass after actions that can orphan a photo (deleting a person,
// replacing/cancelling a photo pick); it deliberately never deletes
// synchronously with those actions, precisely so undo keeps working.
async function gcOrphanedPhotos(){
  try{
    const referenced = new Set();
    people.forEach(p=>{ if(p.photoId) referenced.add(p.photoId); });
    // The add/edit modal's currently-picked photo (if any) hasn't been saved
    // onto a person yet, so it won't show up in `people` above — without
    // this line, picking a second photo in one sitting (see the fPhoto
    // handler) would cause this same GC pass to delete the pick the user
    // just made, since only the *previous* pick is meant to be orphaned.
    if(modalPhotoId) referenced.add(modalPhotoId);
    undoStack.forEach(snapJson=>{
      try{
        const snap = JSON.parse(snapJson);
        (snap.people||[]).forEach(p=>{ if(p.photoId) referenced.add(p.photoId); });
      }catch(e){}
    });
    const entries = await getAllPhotoEntries();
    for(const [id] of entries){
      if(!referenced.has(id)) await purgePhoto(id);
    }
  }catch(e){ console.error('清理未引用照片失败', e); }
}
async function getAllPhotoEntries(){
  const db = await openPhotoDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const store = tx.objectStore(PHOTO_STORE);
    const entries = [];
    const req = store.openCursor();
    req.onsuccess = (e)=>{
      const cursor = e.target.result;
      if(cursor){ entries.push([cursor.key, cursor.value]); cursor.continue(); }
      else resolve(entries);
    };
    req.onerror = ()=>reject(req.error);
  });
}

let photoCache = {}; // photoId -> object URL, populated at startup
function photoSrc(p){
  return (p && p.photoId && photoCache[p.photoId]) || null;
}
async function loadAllPhotosIntoCache(){
  try{
    const entries = await getAllPhotoEntries();
    for(const [id] of entries){
      try{
        const blob = await getPhotoBlob(id);
        if(blob) photoCache[id] = URL.createObjectURL(blob);
      }catch(e){ console.error('加载照片失败', id, e); }
    }
  }catch(e){ console.error('加载照片失败', e); }
}
function dataURLToBlob(dataUrl){
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bin = atob(parts[1]);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type: mime});
}
async function migrateLegacyPhotos(){
  let migrated = 0;
  for(const p of people){
    if(p.photo && !p.photoId){
      try{
        const blob = dataURLToBlob(p.photo);
        const photoId = uid();
        await putPhotoBlob(photoId, blob);
        photoCache[photoId] = URL.createObjectURL(blob);
        p.photoId = photoId;
        delete p.photo;
        migrated++;
      }catch(e){ console.error('迁移照片失败', e); }
    }
  }
  if(migrated>0) saveData();
  return migrated;
}

/* ============ Toast ============ */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ============ Tree layout & render ============ */
function isEffectivelyHidden(id, visited){
  visited = visited || new Set();
  if(visited.has(id)) return false; // cycle guard
  visited.add(id);
  const p = personById(id);
  if(!p) return true;
  if(p.hidden) return true;
  // hidden because a parent is collapsed, or a parent is itself (transitively) hidden
  const viaParent = (p.parents||[]).some(pid=>{
    const par = personById(pid);
    if(!par) return false;
    if(par.collapsed) return true;
    return isEffectivelyHidden(pid, visited);
  });
  if(viaParent) return true;
  // A spouse whose relevance to THIS tree comes entirely from the marriage
  // link — either because they have no recorded parents of their own, or
  // because they're a bridge person from a different family tree (their own
  // ancestry, if any, belongs to that other tree and isn't part of this
  // view) — inherits a hidden state once none of their spousal connections
  // into this view remain visible. Without this they'd stay drawn but
  // orphaned, with no valid anchor for their row position.
  const isBridge = (p.treeId||'main') !== currentTreeId;
  if(((!p.parents || p.parents.length===0) || isBridge) && p.spouses && p.spouses.length){
    return p.spouses.every(sid=> !visited.has(sid) && isEffectivelyHidden(sid, visited));
  }
  return false;
}
let focusExtra = new Set();      // 聚焦时手动点"+"展开的人：其全部后代并入聚焦范围
let focusExtraFor = null;
let focusDownSpouses = true; // include spouses of descendants (子女+配偶 vs only 子女)
let focusSidewaysLevels = new Set(); // which ancestor "distances" (0=本人, 1=父母那代, 2=祖父母那代…) have sideways relatives expanded

function collectSiblingsAndDescendants(id, depthDown, set){
  const p = personById(id);
  if(!p) return;
  const parentIds = (p.parents||[]).filter(pid=>personById(pid));
  parentIds.forEach(pid=>{
    // Make sure the shared parent is part of the focus set too — otherwise,
    // when this anchor person is already at the outer edge of the "up"
    // depth, their parent (one generation further) wouldn't be included,
    // and any siblings we pull in below would have no visible parent to
    // attach to. They'd fall back to being treated as disconnected roots
    // (shown floating at the very top with no connecting line).
    set.add(pid);
    childrenOf(pid).forEach(sib=>{
      if(sib.id===id || set.has(sib.id)) return;
      set.add(sib.id);
      (sib.spouses||[]).forEach(sid=>{ if(personById(sid)) set.add(sid); });
      let frontier = [sib.id];
      for(let g=0; g<depthDown && frontier.length; g++){
        const next = [];
        frontier.forEach(fid=>{
          childrenOf(fid).forEach(c=>{
            if(!set.has(c.id)){
              set.add(c.id);
              (c.spouses||[]).forEach(csid=>{ if(personById(csid)) set.add(csid); });
              next.push(c.id);
            }
          });
        });
        frontier = next;
      }
    });
  });
}

function computeFocusSet(){
  if(!focusPersonId || !personById(focusPersonId)) return null; // null = no restriction
  const set = new Set([focusPersonId]);

  // ancestors — both parents at each generation come along naturally via
  // the .parents array, so no extra spouse step is needed here (adding one
  // would also pull in an ancestor's OTHER unrelated spouses/branches)
  let frontier = [focusPersonId];
  let distance = 0;
  const ancestorDistance = {}; // id -> generations above the focus person
  for(let g=0; g<focusUpGen && frontier.length; g++){
    distance = g+1;
    const next = [];
    frontier.forEach(id=>{
      const p = personById(id);
      (p && p.parents || []).forEach(pid=>{
        if(personById(pid) && !set.has(pid)){
          set.add(pid); next.push(pid);
          ancestorDistance[pid] = distance;
        }
      });
    });
    frontier = next;
  }

  // descendants
  const descendantIds = new Set();
  frontier = [focusPersonId];
  for(let g=0; g<focusDownGen && frontier.length; g++){
    const next = [];
    frontier.forEach(id=>{
      childrenOf(id).forEach(c=>{
        if(!set.has(c.id)){ set.add(c.id); descendantIds.add(c.id); next.push(c.id); }
      });
    });
    frontier = next;
  }

  // include spouses of the focus person themself and of every descendant
  // (sons/daughters-in-law belong in a "family view"), but deliberately not
  // of ancestors, so an ancestor's other unrelated marriages stay out of view
  (focusDownSpouses ? [focusPersonId, ...descendantIds] : [focusPersonId]).forEach(id=>{
    const p = personById(id);
    (p && p.spouses || []).forEach(sid=>{ if(personById(sid)) set.add(sid); });
  });

  // sideways: siblings (and nieces/nephews/cousins) at every generation —
  // the focus person's own siblings get descendants down to focusDownGen
  // (matching their own descendant depth); an ancestor N generations up
  // gets their siblings' descendants traced back down to the focus
  // person's own generation, so first cousins line up at the right row.
  // sideways: siblings (and nieces/nephews/cousins), independently
  // toggleable per generation distance — distance 0 is the focus person's
  // own siblings (their descendants traced down to focusDownGen), distance
  // N is that generation's ancestor's siblings (traced back down to the
  // focus person's own row, so first cousins line up correctly).
  if(focusSidewaysLevels.has(0)){
    collectSiblingsAndDescendants(focusPersonId, focusDownGen, set);
  }
  Object.keys(ancestorDistance).forEach(id=>{
    const d = ancestorDistance[id];
    if(focusSidewaysLevels.has(d)){
      collectSiblingsAndDescendants(id, d, set);
    }
  });

  if(focusExtraFor!==focusPersonId){ focusExtra = new Set(); focusExtraFor = focusPersonId; }
  focusExtra.forEach(xid=>{
    if(!set.has(xid)) return;
    const seen = new Set(), stack = [xid];
    while(stack.length){
      const cur = stack.pop();
      childrenOf(cur).forEach(c=>{
        if(seen.has(c.id)) return; seen.add(c.id);
        set.add(c.id);
        (c.spouses||[]).forEach(sid=>{ if(personById(sid)) set.add(sid); });
        stack.push(c.id);
      });
    }
  });
  return set;
}
let currentTreeMembers = null; // Set of ids belonging to (or bridging into) currentTreeId, recomputed each render()

function computeTreeMembership(targetTreeId){
  const member = new Set();
  people.forEach(p=>{ if((p.treeId||'main')===targetTreeId) member.add(p.id); });
  // Repeatedly expand via marriage bridges and downward-through-children
  // descent until nothing new is added. Doing this as a fixed-point over the
  // whole population (rather than a single recursive walk per person) means
  // the result never depends on which order people happen to be checked in
  // — e.g. a step-daughter who only belongs here via her step-father will
  // correctly pull her own husband in too, regardless of which one gets
  // resolved "first".
  let changed = true;
  while(changed){
    changed = false;
    people.forEach(p=>{
      if(member.has(p.id)) return;
      const spouseIn = (p.spouses||[]).some(sid=>member.has(sid));
      if(spouseIn){ member.add(p.id); changed=true; return; }
      const parentIn = (p.parents||[]).some(pid=>member.has(pid));
      if(parentIn){ member.add(p.id); changed=true; }
    });
  }
  return member;
}
function isVisible(id){
  if(isEffectivelyHidden(id)) return false;
  if(currentFocusSet){
    // Focus mode already computed exactly who's relevant (both sides of
    // ancestry, descendants, optionally siblings/cousins) regardless of
    // which family tree they happen to be tagged under — so skip the tree
    // membership filter here, otherwise a grandparent whose side was
    // organized into a separate tree would silently disappear even though
    // focus mode explicitly asked to include them.
    return currentFocusSet.has(id);
  }
  if(!currentTreeMembers) return true;
  return currentTreeMembers.has(id);
}
function isBridgePerson(id){
  const p = personById(id);
  if(!p) return false;
  return (p.treeId||'main')!==currentTreeId;
}
function visiblePeople(){
  return people.filter(p=>isVisible(p.id));
}
function toggleCollapse(id){
  const p = personById(id);
  if(!p) return;
  if(focusPersonId){
    if(focusExtraFor!==focusPersonId){ focusExtra = new Set(); focusExtraFor = focusPersonId; }
    const fs = computeFocusSet();
    // 孩子被聚焦范围挡住（不是被收起）：点"−"其实想看到他们，把后代并入聚焦范围即可
    if(fs && fs.has(id) && !p.collapsed && childrenOf(id).some(c=>!fs.has(c.id))){
      focusExtra.add(id); render(); renderSidePanel(); return;
    }
  }
  pushHistory();
  p.collapsed = !p.collapsed;
  if(focusPersonId){ if(p.collapsed) focusExtra.delete(id); else { if(focusExtraFor!==focusPersonId){ focusExtra = new Set(); focusExtraFor = focusPersonId; } focusExtra.add(id); } }
  // 子女只要有一方父母处于收起状态就会被隐藏，所以有共同子女的夫妻一起展开/收起，
  // 否则（尤其多位配偶时）只点一个"+"看起来像没反应
  (p.spouses||[]).forEach(sid=>{
    const s = personById(sid);
    if(s && people.some(c=>(c.parents||[]).includes(id) && (c.parents||[]).includes(sid))) s.collapsed = p.collapsed;
  });
  saveData();
  render();
  renderSidePanel();   // panel visibility is governed by panelOpen, so this never pops it open
}
function reorderRow(row, draggedIds, targetIds){
  pushHistory();
  const remaining = row.filter(id=>!draggedIds.includes(id));
  const targetIdx = remaining.indexOf(targetIds[0]);
  const insertAt = targetIdx>=0 ? targetIdx : remaining.length;
  const newRow = remaining.slice(0,insertAt).concat(draggedIds, remaining.slice(insertAt));
  newRow.forEach((id,idx)=>{
    const p = personById(id);
    if(p){
      p.orderHints = p.orderHints || {};
      p.orderHints[currentTreeId] = idx*10;
    }
  });
  // Clear any manual order overrides on this row's descendants (in the
  // current tree) so they re-anchor cleanly under their parents' new
  // positions instead of keeping stale positions that no longer line up —
  // that mismatch is what causes connector lines to cross and tangle.
  const toClear = new Set();
  newRow.forEach(id=> collectDescendants(id, toClear));
  toClear.forEach(id=>{
    const p = personById(id);
    if(p && p.orderHints) delete p.orderHints[currentTreeId];
  });
  saveData();
  render();
  renderSidePanel();
  toast('已调整顺序');
}
function centerTree(){
  requestAnimationFrame(()=>{
    const wrap = document.getElementById('canvasWrap');
    const canvas = document.getElementById('canvas');
    if(!wrap || !canvas || canvas.style.display==='none') return;
    const wrapRect = wrap.getBoundingClientRect();
    const contentWidth = canvas.scrollWidth * zoom;
    pan.x = (wrapRect.width - contentWidth) / 2;
    pan.y = 30;
    applyTransform();
  });
}

function computeLevels(){
  const level = {};

  // Normal forward computation through recorded blood-parent chains.
  // Anyone with no recorded parents defaults to level 0 for now — that's
  // correct for the tree's actual top-level ancestors, but wrong for e.g.
  // an in-law parent whose own ancestry was simply never entered. The
  // refinement loop below corrects those cases afterward.
  function getLevel(id, guard){
    if(level[id]!==undefined) return level[id];
    if(guard.has(id)) return 0; // cycle guard
    guard.add(id);
    const p = personById(id);
    const validParents = (p && p.parents ? p.parents : []).filter(pid=>isVisible(pid));
    if(!p || validParents.length===0){ level[id]=0; return 0; }
    let m = 0;
    validParents.forEach(pid=>{ m = Math.max(m, getLevel(pid, guard)+1); });
    level[id]=m;
    return m;
  }
  visiblePeople().forEach(p=> getLevel(p.id, new Set()));

  const hasKnownAncestry = id=>{
    const p = personById(id);
    return p && p.parents && p.parents.filter(pid=>isVisible(pid)).length>0;
  };

  // Refine: keep syncing spouse levels together, and let anyone with no
  // known ancestry of their own (in-laws) borrow a generation from their
  // children where that suggests they sit deeper than the level-0 default.
  // Only ever moves people DOWN the tree (higher level number), never up,
  // so this converges — an in-law's whole unresolved ancestor chain (their
  // own parents, grandparents, etc, if entered) cascades into place one
  // generation at a time as their nearest resolved descendant settles.
  let changed = true, iter = 0;
  while(changed && iter<40){
    changed = false; iter++;

    // Rule A: anyone with recorded parents should sit at least one level
    // below the deepest of them. Re-applied every iteration (not just once)
    // so that when an in-law parent's own level gets corrected below, their
    // OTHER children (e.g. a spouse's sibling) get pulled down to match too,
    // instead of staying stuck at whatever level was computed before the
    // parent was corrected.
    visiblePeople().forEach(p=>{
      const validParents = (p.parents||[]).filter(pid=>isVisible(pid));
      if(validParents.length){
        const m = Math.max(...validParents.map(pid=>level[pid])) + 1;
        if(m>level[p.id]){ level[p.id]=m; changed=true; }
      }
    });

    // Rule B: keep spouse levels in sync with each other.
    visiblePeople().forEach(p=>{
      (p.spouses||[]).filter(isVisible).forEach(sid=>{
        if(level[sid]!==level[p.id]){
          const m = Math.max(level[sid], level[p.id]);
          if(level[p.id]!==m){ level[p.id]=m; changed=true; }
          if(level[sid]!==m){ level[sid]=m; changed=true; }
        }
      });
    });

    // Rule C: anyone with no ancestry of their own (in-laws) borrows a
    // generation from their children where that suggests they sit deeper
    // than the level-0 default.
    visiblePeople().forEach(p=>{
      if(hasKnownAncestry(p.id)) return;
      const kids = childrenOf(p.id).filter(c=>isVisible(c.id));
      if(kids.length){
        const suggestion = Math.max(...kids.map(c=>level[c.id])) - 1;
        if(suggestion>level[p.id]){ level[p.id]=suggestion; changed=true; }
      }
    });
  }

  return level;
}

function orderPeople(level){
  const visible = visiblePeople();
  const maxLevel = Math.max(0, ...Object.values(level));
  const rows = [];
  for(let l=0;l<=maxLevel;l++) rows.push([]);
  const placed = new Set();

  // seed roots (level 0), sorted by manual orderHint where set, otherwise original insertion order
  const roots = visible.filter(p=>level[p.id]===0);
  roots.sort((a,b)=>{
    const ah = a.orderHints && a.orderHints[currentTreeId];
    const bh = b.orderHints && b.orderHints[currentTreeId];
    const av = ah!==undefined ? ah : roots.indexOf(a)*10;
    const bv = bh!==undefined ? bh : roots.indexOf(b)*10;
    return av-bv;
  });
  roots.forEach(p=>{
    if(placed.has(p.id)) return;
    rows[0].push(p.id); placed.add(p.id);
    (p.spouses||[]).filter(isVisible).forEach(sid=>{
      if(!placed.has(sid) && level[sid]===0){ rows[0].push(sid); placed.add(sid); }
    });
  });
  // any remaining unplaced roots (isolated)
  visible.filter(p=>level[p.id]===0 && !placed.has(p.id)).forEach(p=>{ rows[0].push(p.id); placed.add(p.id); });

  for(let l=0; l<maxLevel; l++){
    // Group not-yet-placed children by the average column position of their
    // parent(s) within row[l] (rather than scanning parent-by-parent in turn).
    // This matters for polygamous / multi-spouse setups: a shared parent (e.g.
    // a husband with several wives) must not "claim" all children from every
    // wife on his own single turn — each child should sort in next to its
    // actual mother's column, not wherever the shared parent happens to sit.
    const rowIndex = {};
    rows[l].forEach((pid, idx)=>{ rowIndex[pid] = idx; });

    const candidates = visible.filter(p=>{
      if(level[p.id]!==l+1 || placed.has(p.id)) return false;
      return (p.parents||[]).some(pid=>rowIndex[pid]!==undefined);
    });

    const withAnchor = candidates.map(c=>{
      const idxs = (c.parents||[]).filter(pid=>rowIndex[pid]!==undefined).map(pid=>rowIndex[pid]);
      const anchor = idxs.reduce((a,b)=>a+b,0) / idxs.length;
      return {c, anchor};
    });
    // v8.23: 孩子永远先按父母所在的列排；同一对父母的孩子之间，再用 排行 > 手动拖动顺序。
    // 之前手动拖动记下的是"当时那一排的绝对位置"，直接拿去和别人的父母位置比较，
    // 换一个显示范围（聚焦/全部）后尺度对不上，孩子就被甩到离父母很远的地方。
    const second = ({c})=>{
      const bo = parseInt(c.birthOrder, 10);
      if(bo>0) return bo;
      const hint = c.orderHints && c.orderHints[currentTreeId];
      return 1000 + (hint!==undefined ? hint : 0);
    };
    withAnchor.sort((x,y)=> (x.anchor-y.anchor) || (second(x)-second(y)));

    withAnchor.forEach(({c})=>{
      if(placed.has(c.id)) return;
      rows[l+1].push(c.id); placed.add(c.id);
      (c.spouses||[]).filter(isVisible).forEach(sid=>{
        if(!placed.has(sid) && level[sid]===l+1){ rows[l+1].push(sid); placed.add(sid); }
      });
    });

    // any unplaced at this level (no linked parent already placed) appended
    visible.filter(p=>level[p.id]===l+1 && !placed.has(p.id)).forEach(p=>{ rows[l+1].push(p.id); placed.add(p.id); });
  }
  return rows;
}

/* ============ v8.11: 亲戚称谓（视角） ============ */
let viewerId = null;          // 设为「我」的人；只存本机视图状态，不进家谱数据
const KIN_CUSTOM_KEY = 'ft_kin_custom_v1';   // 自定义叫法：只存称谓文字，不含人名，仅本机
let kinCustom = (()=>{ try{ const o = JSON.parse(localStorage.getItem(KIN_CUSTOM_KEY)||'{}'), r = {};
  Object.keys(o||{}).forEach(d=>{ r[d] = {}; Object.keys(o[d]||{}).forEach(s=>{ if(typeof o[d][s]==='string') r[d][s] = o[d][s].slice(0,12); }); });
  return r; }catch(e){ return {}; } })();
let kinDialect = 'mandarin';  // mandarin / hakka_sb
let kinMode = 'both';         // both 名字+称谓 / name 只名字 / title 只称谓
let kinMap = null;
let lastCycleSig = '';
function refreshKin(){
  if(viewerId && !personById(viewerId)) viewerId = null;
  kinMap = (viewerId && window.Kinship) ? Kinship.compute(people, viewerId, {dialect: kinDialect, custom: kinCustom[kinDialect]||{}}) : null;
  if(window.Kinship){
    const cyc = Kinship.detectCycles(people), sig = cyc.map(c=>c.join('>')).join(',');
    if(sig && sig!==lastCycleSig){
      const nm = id=>(personById(id)||{}).name||'?';
      toast(`检测到家谱有环：${nm(cyc[0][0])} 与 ${nm(cyc[0][1])} 互为祖先/后代（或配偶同时是父母），请检查，称谓可能不准`);
    }
    lastCycleSig = sig;
  }
  updateViewerBar();
}
function kinInfo(id){ return kinMap ? kinMap.get(id) : null; }
function editKinTitle(std, current){
  const v = prompt('「'+std+'」在你家怎么叫？（留空＝恢复默认）', current||'');
  if(v===null) return;
  const t = v.trim().slice(0,12), m = (kinCustom[kinDialect] = kinCustom[kinDialect]||{});
  if(t) m[std] = t; else delete m[std];
  try{ localStorage.setItem(KIN_CUSTOM_KEY, JSON.stringify(kinCustom)); }catch(e){}
  render(); renderSidePanel();
}
function setViewer(id){
  viewerId = (viewerId===id) ? null : id;
  render(); renderSidePanel(); scheduleSaveViewState();
}
document.getElementById('focusViewerBtn').addEventListener('click', ()=>{ if(focusPersonId) setViewer(focusPersonId); });
function setElder(aId, bId){   // a 比 b 大：记在 a.elder 上（属于家谱数据，随家谱保存/导出）
  const a = personById(aId), b = personById(bId); if(!a||!b) return;
  pushHistory();
  b.elder = (b.elder||[]).filter(x=>x!==aId); if(!b.elder.length) delete b.elder;
  a.elder = Array.from(new Set([...(a.elder||[]), bId]));
  saveData(); render(); renderSidePanel();
}
/* ===== 亲戚图表：弹窗里有 表格 / 树状 两个视图（v8.27 起） =====
   表格：横向按辈分（左长辈→右晚辈），纵向分 父系 / 本人这一辈 / 母系 / 配偶一方
   树状：kintree.js —— 真实存在的人 + 真实父母/配偶关系，我在中间、父系在上、母系在下，可折叠/缩放/存图 */
const KIN_VIEW_KEY = 'ft_kin_chart_view_v1';   // 只记「上次看的是表格还是树状」，不含人名，仅本机
function kinGridHtml(){
  const GEN = {'-4':'高祖辈','-3':'曾祖辈','-2':'祖辈','-1':'父辈','0':'平辈','1':'子辈','2':'孙辈','3':'曾孙辈'};
  const SECTIONS = [['p','父系'],['self','本人这一辈与晚辈'],['m','母系'],['s','配偶一方']];
  const cells = {}; const gens = new Set(); let skipped = 0;
  kinMap.forEach((k,id)=>{
    const p = personById(id); if(!p) return;
    if(!k.title){ skipped++; return; }
    const g = k.place.gen; gens.add(g);
    ((cells[k.place.side] = cells[k.place.side]||{})[g] = (cells[k.place.side]||{})[g]||[]).push({id,p,k});
  });
  const cols = Array.from(gens).sort((x,y)=>x-y);
  const yr = it=>{ const y = parseInt(it.p.birth,10); return isNaN(y) ? 9999 : y; };
  const cell = list=> (list||[]).sort((x,y)=>yr(x)-yr(y) || x.p.name.localeCompare(y.p.name)).map(it=>
    `<div class="kc-item${it.id===viewerId?' me':''}" data-id="${escapeHtml(it.id)}" title="${escapeHtml(it.k.chain)}"><b>${escapeHtml(it.k.title)}</b><span>${escapeHtml(it.p.name)}</span></div>`).join('');
  const body = SECTIONS.filter(([s])=>cells[s]).map(([s,label])=>
    `<tr class="kc-${s}"><th>${label}</th>${cols.map(g=>`<td>${cell((cells[s]||{})[g])}</td>`).join('')}</tr>`).join('');
  return {skipped, html: `<div class="kc-scroll"><table class="kc"><thead><tr><th></th>${cols.map(g=>`<th>${GEN[g]||(g<0?'上'+(-g)+'辈':'下'+g+'辈')}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`};
}
function openKinChart(){
  if(!viewerId || !kinMap) return;
  let ov = document.getElementById('kinChart');
  if(!ov){
    ov = document.createElement('div'); ov.id = 'kinChart'; ov.className = 'kin-chart';
    document.body.appendChild(ov);
    ov.addEventListener('click', e=>{ if(e.target===ov) ov.style.display='none'; });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') ov.style.display='none'; });
  }
  KinTree.show(ov, {
    state: ()=>({people, kinMap, viewerId, viewerName: personById(viewerId).name, dname: (Kinship.DIALECTS[kinDialect]||{}).name || '普通话'}),
    gridHtml: kinGridHtml,
    ctx: {escapeHtml, personById, photoSrc, surnameChar, isDeceased,
      headNote: g=>{   // 列标题下面的小字：以「我」为基准推出这一列父系的派字
        const cfg = paiziCfg(); if(!cfg || !viewerId) return '';
        const v = paiziMap().get(viewerId); if(!v) return '';
        const shi = v.shi + g, ch = Paizi.charsAt(cfg, shi);
        return '父系·' + (ch ? ch.join('/') + '·' : '') + shi + '世';
      }},
    viewGet: ()=>{ try{ return localStorage.getItem(KIN_VIEW_KEY)==='grid' ? 'grid' : 'tree'; }catch(e){ return 'tree'; } },
    viewSet: v=>{ try{ localStorage.setItem(KIN_VIEW_KEY, v); }catch(e){} },
    loadHtml2Canvas, toast,
    pick: id=>enterFocus(id),
    fileName: ()=>{ const t = trees.find(x=>x.id===currentTreeId); return `${(t && t.name) || '家谱'}-亲戚图表-${new Date().toISOString().slice(0,10)}.png`; }
  });
}
function updateViewerBar(){
  const fb = document.getElementById('focusViewerBtn');
  if(fb) fb.textContent = (viewerId && viewerId===focusPersonId) ? '取消「我」视角' : '以此人为「我」';
  let bar = document.getElementById('viewerBar');
  if(!viewerId){ if(bar) bar.style.display='none'; return; }
  if(!bar){
    bar = document.createElement('div'); bar.id='viewerBar'; bar.className='viewer-bar';
    document.body.appendChild(bar);
  }
  const labels = {both:'名字+称谓', name:'只名字', title:'只称谓'};
  bar.style.display='flex';
  bar.innerHTML = `<span>当前视角：<b>${escapeHtml(personById(viewerId).name)}</b></span>
    <button type="button" data-kin="mode">${labels[kinMode]}</button>
    <button type="button" data-kin="dialect" title="${(Kinship.DIALECTS[kinDialect]||{}).unverified ? '这套叫法尚未逐条核实，可在详情面板里点「改叫法」改成你家的' : '切换称谓体系'}">${escapeHtml(((window.Kinship&&Kinship.DIALECTS[kinDialect])||{}).name||'普通话')}</button>
    <button type="button" data-kin="chart" title="以亲戚图表查看">图表</button>
    <button type="button" data-kin="off" title="退出视角">✕</button>`;
  bar.querySelector('[data-kin="mode"]').onclick = ()=>{
    kinMode = kinMode==='both' ? 'title' : kinMode==='title' ? 'name' : 'both';
    render(); scheduleSaveViewState();
  };
  bar.querySelector('[data-kin="dialect"]').onclick = ()=>{
    const keys = Object.keys(Kinship.DIALECTS);
    kinDialect = keys[(keys.indexOf(kinDialect)+1) % keys.length];
    render(); renderSidePanel(); scheduleSaveViewState();
  };
  bar.querySelector('[data-kin="chart"]').onclick = openKinChart;
  bar.querySelector('[data-kin="off"]').onclick = ()=>{ viewerId=null; render(); renderSidePanel(); scheduleSaveViewState(); };
}

function render(){
  refreshKin();
  const canvas = document.getElementById('canvas');
  const emptyState = document.getElementById('emptyState');
  canvas.innerHTML = '';
  updateHiddenBadge();
  currentTreeMembers = computeTreeMembership(currentTreeId);
  currentFocusSet = computeFocusSet();
  updateFocusBar();

  const visCount = visiblePeople().length;

  if(people.length===0){
    emptyState.querySelector('h2').textContent = '还没有家庭成员';
    emptyState.querySelector('p').textContent = '从添加第一位成员开始 —— 可以是你自己，或者家族里最年长的长辈。之后可以为TA添加配偶、子女和父母。';
    document.getElementById('emptyAddBtn').style.display = 'inline-flex';
    emptyState.style.display='flex';
    canvas.style.display='none';
    return;
  }
  if(visCount===0){
    emptyState.style.display='flex';
    emptyState.querySelector('h2').textContent = '所有成员都已被隐藏';
    emptyState.querySelector('p').textContent = '点击右上角"隐藏的成员"可以重新显示他们。';
    document.getElementById('emptyAddBtn').style.display='none';
    canvas.style.display='none';
    return;
  }
  emptyState.style.display='none';
  canvas.style.display='block';

  const level = computeLevels();
  const rows = orderPeople(level);

  lastColumnIndex = {};
  rows.forEach((row, li)=>{
    row.forEach((pid, ci)=>{ lastColumnIndex[pid] = {level: li, col: ci}; });
  });

  const measuredX = {}; // id -> actual rendered center-X (px, relative to canvas), filled in row by row

  rows.forEach((row, li)=>{
    const rowEl = document.createElement('div');
    rowEl.className='gen-row';
    rowEl.dataset.level = li;
    const genLabel = document.createElement('div');
    genLabel.className = 'gen-label';
    genLabel.title = `第 ${li+1} 代`;
    genLabel.innerHTML = `<span>第</span><span>${li+1}</span><span>代</span>`;
    rowEl.appendChild(genLabel);
    canvas.appendChild(rowEl); // append early so we can measure real positions as we go

    let i=0;
    while(i<row.length){
      // Grow a contiguous run of mutually-linked spouses starting at i (not
      // just pairs — a person with several spouses who all sit adjacent, e.g.
      // a polygamous marriage, gets merged into one combined card group).
      const run = [personById(row[i])];
      let j = i+1;
      while(j<row.length){
        const candidate = personById(row[j]);
        const linked = run.some(m=> m.spouses && m.spouses.includes(candidate.id));
        if(!linked) break;
        run.push(candidate);
        j++;
      }

      let el;
      if(run.length>1){
        el = makeCoupleCard(run);
      } else {
        el = document.createElement('div');
        el.className='unit';
        el.appendChild(makeCard(run[0]));
      }
      rowEl.appendChild(el);

      // Manual drag-to-reorder: press and drag this run left/right within
      // its own row to override the automatic ordering. Built on pointer
      // events (not the native HTML5 drag API) so it works reliably on
      // touch devices and inside the panned/zoomed canvas — native drag
      // events are unreliable once a CSS transform/scale is involved.
      const runIds = run.map(m=>m.id);
      el.classList.add('draggable-unit');
      el.dataset.runIds = runIds.join(',');
      el.addEventListener('pointerdown', (e)=>{
        if(e.target.closest('.collapse-toggle') || e.target.closest('.bridge-badge') || e.target.closest('.cname') || e.target.closest('.card-tooltip')) return;
        if(e.button!==undefined && e.button!==0) return;
        dragState = { runIds, row, startX:e.clientX, startY:e.clientY, el, moved:false, pointerId:e.pointerId };
      });
      el.addEventListener('pointermove', (e)=>{
        if(!dragState || dragState.el!==el) return;
        const dx = e.clientX-dragState.startX, dy = e.clientY-dragState.startY;
        if(!dragState.moved && Math.hypot(dx,dy)>8){
          dragState.moved = true;
          el.classList.add('dragging');
          try{ el.setPointerCapture(dragState.pointerId); }catch(err){}
        }
        if(dragState.moved){
          document.querySelectorAll('.draggable-unit.drag-over').forEach(x=>x.classList.remove('drag-over'));
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const targetUnit = under && under.closest && under.closest('.draggable-unit');
          if(targetUnit && targetUnit!==el) targetUnit.classList.add('drag-over');
        }
      });
      el.addEventListener('pointerup', (e)=>{
        if(!dragState || dragState.el!==el) return;
        try{ el.releasePointerCapture(dragState.pointerId); }catch(err){}
        const wasMoved = dragState.moved;
        document.querySelectorAll('.draggable-unit.drag-over').forEach(x=>x.classList.remove('drag-over'));
        el.classList.remove('dragging');
        if(wasMoved){
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const targetUnit = under && under.closest && under.closest('.draggable-unit');
          if(targetUnit && targetUnit!==el && targetUnit.dataset.runIds){
            reorderRow(dragState.row, dragState.runIds, targetUnit.dataset.runIds.split(','));
          }
        }
        dragState = null;
      });
      el.addEventListener('pointercancel', ()=>{
        if(dragState && dragState.el===el){ el.classList.remove('dragging'); dragState=null; }
      });

      // Try to line this run up under its parent(s) — but only by pushing it
      // to the right into open space, never by squeezing left over a sibling
      // that's already placed (i.e. only when the row isn't "full" yet there).
      if(li>0){
        const parentXs = [];
        run.forEach(m=>{ (m.parents||[]).forEach(pid=>{ if(measuredX[pid]!==undefined) parentXs.push(measuredX[pid]); }); });
        if(parentXs.length){
          const canvasRect = canvas.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          const naturalCenter = (elRect.left - canvasRect.left) + elRect.width/2;
          const desiredCenter = parentXs.reduce((a,b)=>a+b,0)/parentXs.length;
          const shift = (desiredCenter - naturalCenter) / zoom;
          if(shift>0) el.style.marginLeft = shift + 'px';
        }
      }

      // record each member's actual final position for the next row to align against
      const canvasRect2 = canvas.getBoundingClientRect();
      run.forEach(m=>{
        const cardEl = findCardEl(el, m.id);
        if(cardEl){
          const cr = cardEl.getBoundingClientRect();
          measuredX[m.id] = (cr.left - canvasRect2.left) + cr.width/2;
        }
      });

      i = j;
    }
  });

  // draw connectors after layout paints
  requestAnimationFrame(drawConnectors);
}

function makeCoupleCard(members){
  const wrap = document.createElement('div');
  wrap.className = 'couple-card';
  members.forEach(m=>{
    wrap.appendChild(makeCard(m, true));
  });
  return wrap;
}

function makeCard(p){
  const card = document.createElement('div');
  const genderClass = p.gender==='F' ? 'gender-f' : (p.gender==='M' ? 'gender-m' : 'gender-o');
  const bridge = isBridgePerson(p.id);
  card.className = 'card ' + genderClass + (p.id===selectedId ? ' selected':'') + (bridge ? ' bridge-card':'') + (isDeceased(p) ? ' deceased':'');
  card.dataset.id = p.id;
  const SIL = '<svg class="sil" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="24" r="11" fill="currentColor"/><path d="M10 60c0-13 9-21 22-21s22 8 22 21z" fill="currentColor"/></svg>';
  const avatarInner = photoSrc(p) ? `<img src="${escapeHtml(photoSrc(p))}" alt="">` : `<span class="ini">${initials(p.name)}</span><span class="sn">${surnameChar(p.name)}</span>${SIL}`;
  const kidCount = childrenOf(p.id).length;
  const collapseBtn = kidCount>0 ? `
    <button class="collapse-toggle ${p.collapsed?'is-collapsed':''}" title="${p.collapsed ? '展开下一代' : '收起下一代'}" data-collapse="${escapeHtml(p.id)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${p.collapsed ? '<path d="M12 5v14M5 12h14"/>' : '<path d="M5 12h14"/>'}</svg>
      ${p.collapsed ? `<span class="collapse-count">${kidCount}</span>` : ''}
    </button>` : '';
  const bridgeBadge = bridge ? `<div class="bridge-badge" data-goto-tree="${escapeHtml(p.id)}" title="属于另一棵家族树，点击前往查看">🔗 ${escapeHtml((trees.find(t=>t.id===(p.treeId||'main'))||{}).name||'其他家族')}</div>` : '';
  const kin = kinInfo(p.id);
  const kinTitle = kin && kin.title;
  const showName = !(kin && kinMode==='title' && kinTitle);
  const kinLine = (kin && kinMode!=='name') ? `<div class="ckin${kinTitle?'':' ckin-none'}">${escapeHtml(kinTitle || (p.id===viewerId?'我':'—'))}</div>` : '';
  if(kin) card.title = (kinTitle ? kinTitle+(kin.std&&kin.std!==kinTitle?'（'+kin.std+'）':'')+(kin.alts&&kin.alts.length?'（又作：'+kin.alts.join('/')+'）':'')+'：' : '') + (kin.chain || '') + (kin.hint ? '（'+kin.hint+'）' : '');
  if(p.id===viewerId) card.classList.add('is-viewer');
  card.innerHTML = `
    ${collapseBtn}
    <button class="card-info-btn" title="查看详情 / 编辑">i</button>
    <button class="card-me-btn${p.id===viewerId?' on':''}" title="${p.id===viewerId?'取消「我」视角':'设为「我」（视角）'}">我</button>
    <div class="avatar"${isDeceased(p) ? ' title="已故"' : ''}>${avatarInner}</div>
    <div class="cname">${escapeHtml(showName ? p.name : kinTitle)}</div>
    ${kinLine}
    <div class="cspan">${escapeHtml(lifespanShort(p))}</div>
    <div class="corder">${escapeHtml(birthOrderLabel(p))}</div>
    <div class="cyears">${[birthOrderLabel(p), yearsLabel(p)].filter(Boolean).join(' · ')}</div>
    ${bridgeBadge}
    ${p.notes ? `<div class="card-tooltip">${escapeHtml(p.notes)}</div>` : ''}
  `;
  card.addEventListener('click', ()=>enterFocus(p.id));
  const meBtn = card.querySelector('.card-me-btn');
  if(meBtn) meBtn.addEventListener('click', (e)=>{ e.stopPropagation(); setViewer(p.id); });
  const infoBtn = card.querySelector('.card-info-btn');
  if(infoBtn){
    infoBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      if(panelOpen && selectedId===p.id){
        panelOpen = false;           // click 'i' again -> close
        render();
        renderSidePanel();
        recordNavState();
      } else {
        selectPerson(p.id);
      }
    });
  }
  const bridgeEl = card.querySelector('.bridge-badge');
  if(bridgeEl){
    bridgeEl.addEventListener('click', (e)=>{
      e.stopPropagation();
      goToBridgePerson(p.id);
    });
  }
  const cbtn = card.querySelector('.collapse-toggle');
  if(cbtn){
    cbtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleCollapse(p.id);
    });
  }
  return card;
}

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function drawConnectors(){
  const canvas = document.getElementById('canvas');
  const old = canvas.querySelector('svg.connectors');
  if(old) old.remove();
  const canvasRect = canvas.getBoundingClientRect();
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS,'svg');
  svg.setAttribute('class','connectors');
  svg.setAttribute('width', canvas.scrollWidth);
  svg.setAttribute('height', canvas.scrollHeight);

  function cardRect(id){
    const el = findCardEl(canvas, id);
    if(!el) return null;
    const r = el.getBoundingClientRect();
    // r is already scaled by the canvas's own CSS transform (scale(zoom)).
    // This svg lives inside that same transformed canvas, so it will be
    // scaled by zoom too — dividing by zoom here undoes the one already
    // baked into getBoundingClientRect, so the net scaling applied ends up
    // happening exactly once (matching the cards) instead of twice.
    const avEl = el.querySelector('.avatar');
    const ar = avEl ? avEl.getBoundingClientRect() : r;
    return {
      cx: (r.left - canvasRect.left + r.width/2) / zoom,
      top: (r.top - canvasRect.top) / zoom,
      bottom: (r.bottom - canvasRect.top) / zoom,
      width: r.width / zoom,
      // avatar geometry — used by the compact (icon-style) view
      avTop: (ar.top - canvasRect.top) / zoom,
      avCy: (ar.top - canvasRect.top + ar.height/2) / zoom,
      avLeft: (ar.left - canvasRect.left) / zoom,
      avRight: (ar.right - canvasRect.left) / zoom
    };
  }
  const compact = document.body.classList.contains('compact-view');
  const COMPACT_LINE = '#8E8A83';
  const COMPACT_PALETTE = ['#C4572A','#2E7F8C','#7B5BA8','#5E8F3E','#C08A1E','#3F6DB8','#B8416E','#5F6B73'];
  function addDot(x, y){
    const g = document.createElementNS(svgNS,'g');
    const c1 = document.createElementNS(svgNS,'circle');
    c1.setAttribute('cx',x); c1.setAttribute('cy',y); c1.setAttribute('r',11); c1.setAttribute('fill',COMPACT_LINE);
    const c2 = document.createElementNS(svgNS,'circle');
    c2.setAttribute('cx',x); c2.setAttribute('cy',y); c2.setAttribute('r',5); c2.setAttribute('fill','none');
    c2.setAttribute('stroke','#fff'); c2.setAttribute('stroke-width','2');
    g.appendChild(c1); g.appendChild(c2); svg.appendChild(g);
  }
  function marriageLine(a, b){ // straight line between two avatars + dot in the middle
    const [l, r] = a.cx <= b.cx ? [a, b] : [b, a];
    const y = l.avCy, x1 = l.avRight, x2 = r.avLeft;
    const path = document.createElementNS(svgNS,'path');
    path.setAttribute('d', `M ${x1} ${y} L ${x2} ${y}`);
    path.setAttribute('stroke', COMPACT_LINE); path.setAttribute('stroke-width','3'); path.setAttribute('fill','none');
    svg.appendChild(path);
    addDot((x1+x2)/2, y);
  }
  function marriageArc(a, b){ // spouses with someone sitting between them: arc over the top
    const [l, r] = a.cx <= b.cx ? [a, b] : [b, a];
    const y = Math.min(l.avTop, r.avTop) - 4;
    const path = document.createElementNS(svgNS,'path');
    path.setAttribute('d', `M ${l.cx} ${y} C ${l.cx} ${y-34} ${r.cx} ${y-34} ${r.cx} ${y}`);
    path.setAttribute('stroke', COMPACT_LINE); path.setAttribute('stroke-width','3'); path.setAttribute('fill','none');
    svg.appendChild(path);
    addDot((l.cx+r.cx)/2, y-25);
  }

  // marriage lines
  const drawnPairs = new Set();
  visiblePeople().forEach(p=>{
    (p.spouses||[]).filter(isVisible).forEach(sid=>{
      const key = [p.id,sid].sort().join('|');
      if(drawnPairs.has(key)) return;
      drawnPairs.add(key);
      const elA = findCardEl(canvas, p.id);
      const elB = findCardEl(canvas, sid);
      if(elA && elB && elA.parentElement===elB.parentElement && elA.parentElement.classList.contains('couple-card')){
        return; // already visually joined into one merged card (compact view draws these below)
      }
      const a = cardRect(p.id), b = cardRect(sid);
      if(!a||!b) return;
      if(compact){ marriageLine(a, b); return; }
      const y = (a.top+a.bottom)/2;
      const path = document.createElementNS(svgNS,'path');
      path.setAttribute('d', `M ${a.cx+a.width/2-4} ${y} L ${b.cx-b.width/2+4} ${y}`);
      path.setAttribute('stroke', 'var(--accent-2)');
      path.setAttribute('stroke-width','2.5');
      path.setAttribute('fill','none');
      svg.appendChild(path);
    });
  });

  // compact view: marriage line + dot between spouses inside a merged couple group
  if(compact){
    canvas.querySelectorAll('.couple-card').forEach(cc=>{
      const cards = Array.from(cc.querySelectorAll(':scope > .card'));
      for(let x=0; x<cards.length; x++){
        for(let y=x+1; y<cards.length; y++){
          const A = personById(cards[x].dataset.id), B = personById(cards[y].dataset.id);
          if(!A || !B || !(A.spouses||[]).includes(B.id)) continue;
          const ra = cardRect(A.id), rb = cardRect(B.id);
          if(!ra || !rb) continue;
          if(y===x+1) marriageLine(ra, rb); else marriageArc(ra, rb);
        }
      }
    });
  }

  // parent-child connectors — collect first, draw after, so we can rank
  // lines feeding into the SAME target row by horizontal position and
  // spread their elbow heights out evenly. (Using a hash for this instead
  // can coincidentally give two nearby-but-unrelated family groups almost
  // the same bend height, making their lines look like they cross or join
  // in empty space between unrelated cards.)
  const connectorJobs = [];
  visiblePeople().forEach(child=>{
    if(!child.parents || child.parents.length===0) return;
    const validParents = child.parents.filter(pid=>isVisible(pid));
    if(validParents.length===0) return;

    // Group parents into clusters of people who actually sit next to each
    // other on screen (a real couple rendered together). This generalizes
    // beyond just 2 parents — e.g. a stepchild with 2 biological parents
    // (adjacent to each other) plus a step-parent recorded elsewhere in the
    // tree entirely. Averaging every parent's x-position in one go would
    // land the line in empty space between unrelated cards; instead each
    // cluster gets its OWN connector line straight to the child.
    const withPos = validParents
      .map(pid=>({pid, pos:lastColumnIndex[pid]}))
      .filter(x=>x.pos)
      .sort((a,b)=> a.pos.level-b.pos.level || a.pos.col-b.pos.col);
    const clusters = [];
    withPos.forEach(item=>{
      const last = clusters[clusters.length-1];
      const prev = last && last[last.length-1];
      const prevPerson = prev && personById(prev.pid);
      const areSpouses = prevPerson && prevPerson.spouses && prevPerson.spouses.includes(item.pid);
      if(prev && prev.pos.level===item.pos.level && item.pos.col-prev.pos.col===1 && areSpouses){
        last.push(item);
      } else {
        clusters.push([item]);
      }
    });
    // parents we couldn't locate on screen at all (shouldn't normally happen) fall back to their own solo cluster
    validParents.forEach(pid=>{ if(!lastColumnIndex[pid]) clusters.push([{pid, pos:null}]); });

    const childRect = cardRect(child.id);
    if(!childRect) return;
    const endX = childRect.cx;
    const endY = compact ? childRect.avTop : childRect.top;
    const childLevel = lastColumnIndex[child.id] ? lastColumnIndex[child.id].level : -1;

    clusters.forEach(cluster=>{
      const anchorIds = cluster.map(c=>c.pid);
      const rects = anchorIds.map(cardRect).filter(Boolean);
      if(rects.length===0) return;
      const startX = rects.reduce((s,r)=>s+r.cx,0)/rects.length;
      // compact view: a couple's children hang from the marriage dot between them
      const startY = (compact && rects.length>1)
        ? rects.reduce((sum,r)=>sum+r.avCy,0)/rects.length
        : Math.max(...rects.map(r=>r.bottom));
      const familyKey = anchorIds.slice().sort().join('|');
      connectorJobs.push({familyKey, startX, startY, endX, endY, childLevel});
    });
  });

  // Rank distinct family-groups feeding into each target row by their
  // horizontal position, and space their elbow heights out evenly across
  // that row's connectors — so lines naturally nest instead of colliding.
  const lineColors = ['#8B7355','#5C7A6E','#A0654F','#6B7FA3','#8A6A8C','#7A8B4E','#B0764F','#5E8A8E'];
  const byLevel = {};
  connectorJobs.forEach(job=>{
    (byLevel[job.childLevel] = byLevel[job.childLevel] || {});
    if(!byLevel[job.childLevel][job.familyKey]) byLevel[job.childLevel][job.familyKey] = [];
    byLevel[job.childLevel][job.familyKey].push(job);
  });
  Object.values(byLevel).forEach(familyMap=>{
    const families = Object.keys(familyMap).map(key=>{
      const jobs = familyMap[key];
      const avgX = jobs.reduce((s,j)=>s+j.startX,0)/jobs.length;
      return {key, jobs, avgX};
    });
    families.sort((a,b)=>a.avgX-b.avgX);
    const n = families.length;
    // Compact view: stay neutral grey when the families in this row are clearly
    // separate (easy to read); switch to one colour per family only when their
    // horizontal extents overlap, i.e. when grey lines would be hard to tell apart.
    families.forEach(f=>{
      const xs = f.jobs.flatMap(j=>[j.startX, j.endX]);
      f.minX = Math.min(...xs); f.maxX = Math.max(...xs);
    });
    let rowNeedsColor = false;
    for(let i=0; i<n && !rowNeedsColor; i++){
      for(let j=i+1; j<n; j++){
        if(families[i].minX < families[j].maxX && families[j].minX < families[i].maxX){ rowNeedsColor = true; break; }
      }
    }
    families.forEach((fam, idx)=>{
      const fraction = n<=1 ? 0.5 : 0.28 + (idx/(n-1))*0.5;
      let hash = 0;
      for(let i=0;i<fam.key.length;i++){ hash = (hash*31 + fam.key.charCodeAt(i)) | 0; }
      const lineColor = lineColors[Math.abs(hash) % lineColors.length];
      // neighbours get consecutive palette colours, so overlapping families never clash
      const compactColor = rowNeedsColor ? COMPACT_PALETTE[idx % COMPACT_PALETTE.length] : COMPACT_LINE;
      fam.jobs.forEach(job=>{
        const midY = job.startY + (job.endY-job.startY)*fraction;
        const path = document.createElementNS(svgNS,'path');
        path.setAttribute('d', `M ${job.startX} ${job.startY} L ${job.startX} ${midY} L ${job.endX} ${midY} L ${job.endX} ${job.endY}`);
        path.setAttribute('stroke', compact ? compactColor : lineColor);
        path.setAttribute('stroke-width', compact ? '3' : '2.5');
        path.setAttribute('stroke-linejoin','round');
        path.setAttribute('fill','none');
        path.setAttribute('opacity','0.95');
        svg.appendChild(path);
      });
    });
  });

  canvas.insertBefore(svg, canvas.firstChild);
}

/* ============ Hide / unhide ============ */
function setPersonVisible(id, visible){
  const p = personById(id);
  if(!p) return;
  p.hidden = !visible;
}

function hidePerson(id){
  pushHistory();
  const p = personById(id);
  if(!p) return;
  setPersonVisible(id, false);
  if(selectedId===id) selectedId=null;
  saveData();
  render();
  renderSidePanel();
  renderHiddenPanel();
  centerTree();
  toast(`已隐藏「${p.name}」及其后代分支，可在"显示筛选"中恢复`);
}
function unhidePerson(id){
  pushHistory();
  const p = personById(id);
  if(!p) return;
  setPersonVisible(id, true);
  saveData();
  render();
  renderSidePanel();
  renderHiddenPanel();
  centerTree();
  toast(`已恢复显示「${p.name}」及其后代分支`);
}
function updateHiddenBadge(){
  const hiddenCount = people.filter(p=>p.hidden).length;
  const badge = document.getElementById('hiddenCount');
  if(!badge) return;
  badge.textContent = hiddenCount>0 ? hiddenCount : '';
}
function enterFocus(id){
  const p = personById(id);
  if(!p) return;
  const firstEntry = !focusPersonId;
  if(firstEntry){
    // first time: show just the immediate circle — parents, spouse, children, siblings
    focusUpGen = 1;
    focusDownGen = 1;
    focusDownSpouses = true;
    focusSidewaysLevels = new Set([0]);
  }
  focusPersonId = id;
  selectedId = id;          // highlight the card, but keep the detail panel closed
  panelOpen = false;
  render();
  renderSidePanel();
  centerOnPerson(id, true);
  pulseCard(id);
  recordNavState();
}
// v8.10: brief yellow blink on the focused person (3 pulses, then a steady ring)
function pulseCard(id){
  setTimeout(()=>{
    const el = findCardEl(document, id);
    if(!el) return;
    el.classList.remove('focus-pulse');
    void el.offsetWidth;                       // restart the animation
    el.classList.add('focus-pulse');
    setTimeout(()=>el.classList.remove('focus-pulse'), 2600);
  }, 200);
}
function isPhoneLayout(){ return window.matchMedia('(max-width:720px)').matches; }   // 和 index.html 里手机那组 CSS 的断点一致
function centerOnPerson(id, afterRender){
  const run = ()=>{
    const wrap = document.getElementById('canvasWrap');
    const el = findCardEl(document, id);
    if(!wrap || !el){ centerTree(); return; }
    const wrapRect = wrap.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elCenterX = elRect.left + elRect.width/2;
    const elCenterY = elRect.top + elRect.height/2;
    const wrapCenterX = wrapRect.left + wrapRect.width/2;
    // v8.28: 手机上详情是底部抽屉，居中要对着抽屉上面那块可见区域，不然人会被抽屉盖住
    const sheet = document.getElementById('sidePanel');
    const sheetOpen = isPhoneLayout() && sheet && !sheet.classList.contains('hidden');
    const visibleBottom = sheetOpen ? Math.max(wrapRect.top + 120, Math.min(wrapRect.bottom, window.innerHeight - sheet.offsetHeight)) : wrapRect.bottom;
    const wrapCenterY = wrapRect.top + (visibleBottom - wrapRect.top)/2;
    // pan is a plain screen-pixel offset (applied outside the canvas's own
    // scale), so a plain screen-pixel delta can be added directly here.
    pan.x += (wrapCenterX - elCenterX);
    pan.y += (wrapCenterY - elCenterY);
    applyTransform();
  };
  if(afterRender) requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(run, 30)));
  else requestAnimationFrame(run);
}
function exitFocus(){
  const previousFocus = focusPersonId;
  focusPersonId = null;
  render();
  renderSidePanel();
  if(previousFocus && personById(previousFocus)) centerOnPerson(previousFocus);
  else centerTree();
  recordNavState();
}
function adjustFocusGen(which, delta){
  if(which==='up') focusUpGen = Math.max(0, Math.min(15, focusUpGen+delta));
  else focusDownGen = Math.max(0, Math.min(15, focusDownGen+delta));
  render();
  centerOnPerson(focusPersonId, true);
}
function renameCurrentTree(){
  const t = trees.find(x=>x.id===currentTreeId);
  if(!t) return;
  const name = prompt('给这棵家族树改个名字：', t.name);
  if(!name || !name.trim() || name.trim()===t.name) return;
  pushHistory();
  t.name = name.trim();
  saveData();
  renderTreeSelect();
  toast(`已重命名为「${t.name}」`);
}

/* ============ Back / forward browsing history ============ */
/* ============ v8.6: remember the last-visited place across quit / reopen ============
   Stores only opaque ids + numbers (tree id, focused person id, zoom, pan) —
   no names or personal data — so it lives in plain localStorage and can be
   written synchronously when the page is hidden/closed (the encrypted main
   store is async and may not finish in time). Nothing is written until init()
   has finished restoring, so the lock screen can't overwrite the saved spot
   with defaults. */
const VIEW_STATE_KEY = 'ft_last_view_v1';
let viewStateReady = false;
let viewSaveTimer = null;
function saveViewState(){
  if(!viewStateReady) return;
  try{
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
      treeId: currentTreeId,
      focusPersonId: focusPersonId,
      selectedId: selectedId,
      focusUpGen: focusUpGen,
      focusDownGen: focusDownGen,
      focusDownSpouses: focusDownSpouses,
      focusSidewaysLevels: Array.from(focusSidewaysLevels),
      viewerId: viewerId,
      kinMode: kinMode,
      kinDialect: kinDialect,
      zoom: zoom,
      pan: { x: pan.x, y: pan.y }
    }));
  }catch(e){}
}
function scheduleSaveViewState(){
  if(!viewStateReady) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveViewState, 400);
}
function readViewState(){
  try{
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
// Applies a saved view if it still makes sense; returns true if the pan/zoom
// was restored (so init() should skip the default centerTree()).
function applySavedViewState(v){
  if(!v || typeof v!=='object') return false;
  if(typeof v.viewerId==='string' && personById(v.viewerId)) viewerId = v.viewerId;
  if(['both','name','title'].includes(v.kinMode)) kinMode = v.kinMode;
  if(window.Kinship && Kinship.DIALECTS[v.kinDialect]) kinDialect = v.kinDialect;
  if(!trees.some(t=>t.id===v.treeId)) return false;
  currentTreeId = v.treeId;
  if(v.focusPersonId && personById(v.focusPersonId)){
    focusPersonId = v.focusPersonId;
    if(Number.isFinite(v.focusUpGen)) focusUpGen = v.focusUpGen;
    if(Number.isFinite(v.focusDownGen)) focusDownGen = v.focusDownGen;
    focusDownSpouses = v.focusDownSpouses !== false;
    focusSidewaysLevels = new Set(Array.isArray(v.focusSidewaysLevels) ? v.focusSidewaysLevels : []);
  }
  if(v.selectedId && personById(v.selectedId)) selectedId = v.selectedId;
  const z = Number(v.zoom), px = v.pan && Number(v.pan.x), py = v.pan && Number(v.pan.y);
  if(Number.isFinite(z) && z>=0.3 && z<=2 && Number.isFinite(px) && Number.isFinite(py)){
    zoom = z; pan.x = px; pan.y = py;
    return true;
  }
  return false;
}
window.addEventListener('pagehide', saveViewState);
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') saveViewState(); });

let navHistory = [];
let navIndex = -1;
let navigatingHistory = false; // guard so restoring a state doesn't re-record itself
function recordNavState(){
  scheduleSaveViewState();
  if(navigatingHistory) return;
  const state = { selectedId, currentTreeId, focusPersonId, focusUpGen, focusDownGen, focusDownSpouses, focusSidewaysLevels: Array.from(focusSidewaysLevels) };
  const prev = navHistory[navIndex];
  if(prev && JSON.stringify(prev)===JSON.stringify(state)) return; // no real change, skip
  navHistory = navHistory.slice(0, navIndex+1);
  navHistory.push(state);
  navIndex = navHistory.length-1;
  if(navHistory.length>50){ navHistory.shift(); navIndex--; }
  updateNavButtons();
}
function restoreNavState(state){
  navigatingHistory = true;
  selectedId = state.selectedId;
  currentTreeId = state.currentTreeId;
  focusPersonId = state.focusPersonId;
  focusUpGen = state.focusUpGen;
  focusDownGen = state.focusDownGen;
  focusDownSpouses = state.focusDownSpouses !== false;
  focusSidewaysLevels = new Set(state.focusSidewaysLevels || []);
  renderTreeSelect();
  render();
  renderSidePanel();
  if(selectedId && personById(selectedId)) centerOnPerson(selectedId);
  else if(focusPersonId && personById(focusPersonId)) centerOnPerson(focusPersonId);
  else centerTree();
  navigatingHistory = false;
  updateNavButtons();
}
function navBack(){
  if(navIndex<=0) return;
  navIndex--;
  restoreNavState(navHistory[navIndex]);
}
function navForward(){
  if(navIndex>=navHistory.length-1) return;
  navIndex++;
  restoreNavState(navHistory[navIndex]);
}
function updateNavButtons(){
  const backBtn = document.getElementById('navBackBtn');
  const fwdBtn = document.getElementById('navForwardBtn');
  if(backBtn) backBtn.disabled = navIndex<=0;
  if(fwdBtn) fwdBtn.disabled = navIndex>=navHistory.length-1;
}

function renderTreeSelect(){
  const sel = document.getElementById('treeSelect');
  if(!sel) return;
  sel.innerHTML = trees.map(t=>`<option value="${escapeHtml(t.id)}" ${t.id===currentTreeId?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
}
function switchTree(treeId){
  if(!trees.some(t=>t.id===treeId)) return;
  currentTreeId = treeId;
  selectedId = null;
  focusPersonId = null;
  saveData();
  renderTreeSelect();
  render();
  renderSidePanel();
  centerTree();
  recordNavState();
}
function addNewTree(){
  const name = prompt('新家族树的名称，例如"妻子的家族"：');
  if(!name || !name.trim()) return;
  pushHistory();
  const id = 'tree_' + Date.now();
  trees.push({id, name: name.trim()});
  currentTreeId = id;
  saveData();
  renderTreeSelect();
  render();
  renderSidePanel();
  centerTree();
  toast(`已新建「${name.trim()}」，现在添加的成员会归入这棵树`);
}
function collectDescendants(id, acc){
  acc = acc || new Set();
  childrenOf(id).forEach(c=>{
    if(!acc.has(c.id)){ acc.add(c.id); collectDescendants(c.id, acc); }
  });
  return acc;
}
let moveTreePersonId = null;
function openMoveTreeModal(id){
  const p = personById(id);
  if(!p) return;
  moveTreePersonId = id;
  document.getElementById('moveTreeSubject').textContent = `将「${p.name}」移动到：`;
  const sel = document.getElementById('moveTreeSelect');
  sel.innerHTML = trees.filter(t=>t.id!==(p.treeId||'main')).map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  document.getElementById('moveTreeCascade').checked = true;
  document.getElementById('moveTreeOverlay').classList.add('show');
}
function confirmMoveTree(){
  pushHistory();
  const p = personById(moveTreePersonId);
  if(!p) return;
  const targetTreeId = document.getElementById('moveTreeSelect').value;
  const cascade = document.getElementById('moveTreeCascade').checked;
  if(!targetTreeId) return;
  const ids = new Set([p.id]);
  if(cascade) collectDescendants(p.id, ids);
  ids.forEach(id=>{
    const person = personById(id);
    if(person) person.treeId = targetTreeId;
  });
  saveData();
  document.getElementById('moveTreeOverlay').classList.remove('show');
  selectedId = null;
  render();
  renderSidePanel();
  centerTree();
  toast(`已移动 ${ids.size} 位成员到「${trees.find(t=>t.id===targetTreeId).name}」`);
}
function goToBridgePerson(id){
  const p = personById(id);
  if(!p) return;
  currentTreeId = p.treeId || 'main';
  focusPersonId = null;
  selectedId = id;
  saveData();
  renderTreeSelect();
  render();
  renderSidePanel();
  centerTree();
  recordNavState();
}
function updateFocusBar(){
  const bar = document.getElementById('focusBar');
  if(!bar) return;
  if(!focusPersonId || !personById(focusPersonId)){
    bar.style.display='none';
    document.body.classList.remove('has-focus-bar');
    return;
  }
  bar.style.display='flex';
  document.body.classList.add('has-focus-bar');
  document.getElementById('focusName').textContent = personById(focusPersonId).name;
  document.getElementById('focusUpVal').textContent = focusUpGen;
  document.getElementById('focusDownVal').textContent = focusDownGen;
  document.querySelectorAll('#quickUp [data-up]').forEach(b=>{
    const v = parseInt(b.dataset.up,10);
    b.classList.toggle('active', v>=15 ? focusUpGen>=15 : focusUpGen===v);
  });
  document.querySelectorAll('#quickDown [data-down]').forEach(b=>{
    const v = parseInt(b.dataset.down,10), sp = b.dataset.sp==='1';
    b.classList.toggle('active', (v>=15 ? focusDownGen>=15 : focusDownGen===v) && focusDownSpouses===sp);
  });

  const genNames = ['本人','父母','祖父母','曾祖父母','高祖父母'];
  const wrap = document.getElementById('focusSidewaysToggles');
  if(wrap){
    const chips = [];
    for(let d=0; d<=focusUpGen; d++){
      const label = genNames[d] || `上${d}代`;
      chips.push(`<button class="sideways-chip ${focusSidewaysLevels.has(d)?'active':''}" data-sideways-level="${d}" title="展开这一代的兄弟姐妹/表亲">旁支·${label}</button>`);
    }
    wrap.innerHTML = chips.join('');
    wrap.querySelectorAll('[data-sideways-level]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const d = parseInt(chip.dataset.sidewaysLevel, 10);
        if(focusSidewaysLevels.has(d)) focusSidewaysLevels.delete(d);
        else focusSidewaysLevels.add(d);
        render();
        centerOnPerson(focusPersonId, true);
      });
    });
  }
}
let mapHubCountry = null; // user-chosen country to draw root-style connector lines from
let worldMapSVGText = null; // cached after first successful load
let worldMapLoadAttempted = false;
async function loadWorldMapSVG(){
  // Bundled locally (assets/world-map.svg) instead of fetched from a mutable
  // CDN @master ref, so there's nothing to verify at runtime and no
  // third-party request is made just to open the map view.
  if(worldMapSVGText || worldMapLoadAttempted) return worldMapSVGText;
  worldMapLoadAttempted = true;
  try{
    const res = await fetch('./assets/world-map.svg');
    if(res.ok){
      const text = await res.text();
      if(text.includes('<svg') && text.includes('<path')){
        worldMapSVGText = text;
        return worldMapSVGText;
      }
    }
  }catch(e){ /* asset missing or unreadable */ }
  return null;
}

// Pushes apart any label anchor points that are closer than `minSep` to each
// other, using a few iterations of simple pairwise repulsion, and returns a
// NEW position map (the original pin positions passed in are left untouched
// — they still anchor the dot itself; only the returned label positions may
// have moved).
function declutterLabelPositions(positions, names, W, H){
  const minSep = Math.min(W, H) * 0.075;
  const pts = names.map(n=>({name:n, x:positions[n].x, y:positions[n].y}));
  for(let iter=0; iter<60; iter++){
    let moved = false;
    for(let i=0;i<pts.length;i++){
      for(let j=i+1;j<pts.length;j++){
        const a = pts[i], b = pts[j];
        let dx = b.x-a.x, dy = b.y-a.y;
        let dist = Math.hypot(dx,dy);
        if(dist < minSep){
          moved = true;
          if(dist < 0.001){ dx = 1; dy = -1; dist = Math.hypot(dx,dy); } // identical points: pick a fixed direction
          const push = (minSep-dist)/2;
          const ux = dx/dist, uy = dy/dist;
          a.x -= ux*push; a.y -= uy*push;
          b.x += ux*push; b.y += uy*push;
        }
      }
    }
    if(!moved) break;
  }
  const result = {};
  pts.forEach(p=>{ result[p.name] = {x:p.x, y:p.y}; });
  return result;
}

async function renderMapView(){
  const wrap = document.getElementById('mapCanvasWrap');
  const outerWrap = document.getElementById('mapCanvasOuter');
  if(!wrap) return;
  if(outerWrap){ const oldPop = outerWrap.querySelector('.map-popover'); if(oldPop) oldPop.remove(); }
  wrap.innerHTML = '<div class="map-empty">正在加载地图…</div>';

  // group people (across all trees) by matched country
  const groups = {}; // countryName -> {lat,lng,iso,people:[]}
  people.forEach(p=>{
    if(!p.country) return;
    const match = lookupCountryCoords(p.country);
    if(!match) return;
    if(!groups[match.name]) groups[match.name] = {name:match.name, lat:match.lat, lng:match.lng, iso:match.iso, people:[]};
    groups[match.name].people.push(p);
  });
  const countryNames = Object.keys(groups);

  if(countryNames.length===0){
    wrap.innerHTML = '<div class="map-empty">还没有成员填写"居住国家"。<br>在编辑成员时填写这个字段，就会在地图上显示出来。</div>';
    return;
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const mapText = await loadWorldMapSVG();

  let svg, W, H, getPinPos;

  if(mapText){
    // Real world map: parse it, recolor to match the app's palette, and find
    // each matched country's actual shape (by ISO code) to anchor pins
    // precisely — no lat/lng guesswork needed for countries it contains.
    const parser = new DOMParser();
    const doc = parser.parseFromString(mapText, 'image/svg+xml');
    svg = doc.querySelector('svg');
    svg = document.importNode(svg, true);
    const vb = (svg.getAttribute('viewBox')||'0 0 1000 500').split(/\s+/).map(Number);
    const [minX, minY] = vb; W = vb[2]; H = vb[3];
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.style.width = '100%'; svg.style.display = 'block';
    svg.querySelectorAll('path').forEach(p=>{
      p.setAttribute('fill', '#E4D9BE');
      p.setAttribute('stroke', '#C9B98F');
      p.setAttribute('stroke-width', '0.6');
    });
    // Small territories that have no shape of their own in this simplified
    // map AND sit close enough to another country's coastline that the
    // naive lat/lng→pixel formula below (which assumes a strict equirect-
    // angular projection this hand-drawn map doesn't actually follow) lands
    // them in the wrong place — e.g. Hong Kong's formula position landed up
    // near Bohai Bay, ~60px too far north. These were hand-picked to sit on
    // the real coastline point in THIS map's own coordinate space.
    const PIN_PIXEL_OVERRIDES = {
      '香港': {x:670.2, y:470.4},
      '澳门': {x:667.0, y:472.0},
    };
    getPinPos = (g)=>{
      if(g.name && PIN_PIXEL_OVERRIDES[g.name]) return PIN_PIXEL_OVERRIDES[g.name];
      const fallback = {x: minX+(g.lng+180)/360*W, y: minY+(90-g.lat)/180*H};
      if(g.iso){
        // Prefer the country's actual "mainland" child path (many countries
        // are grouped as <g id="xx"><path class="mainland">...</path><path>
        // ...overseas islands/territories...</path></g> — using the whole
        // group's bbox would get dragged off toward far-flung exclaves like
        // French Guiana or Réunion, badly skewing the pin position).
        let el = svg.querySelector('#'+g.iso+' path.mainland');
        if(!el) el = svg.querySelector('#'+g.iso);
        if(el && el.getBBox){
          try{
            const bb = el.getBBox();
            const isoPos = {x: bb.x+bb.width/2, y: bb.y+bb.height/2};
            // Sanity-check against the rough lat/lng position — if the ISO
            // match landed far from where the country should roughly be
            // (e.g. it matched a stray/wrongly-labeled fragment), trust the
            // lat/lng fallback instead rather than showing an obviously
            // wrong location like "France" pinned in the Sahara.
            const dx = Math.abs(isoPos.x-fallback.x)/W, dy = Math.abs(isoPos.y-fallback.y)/H;
            if(dx<0.3 && dy<0.3) return isoPos;
          }catch(e){}
        }
      }
      return fallback;
    };
  } else {
    // Fallback: simplified schematic continents (used if the map couldn't be
    // fetched — e.g. no internet access at the moment)
    W = 1000; H = 500;
    svg = document.createElementNS(svgNS,'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = '100%'; svg.style.display = 'block';
    const ocean = document.createElementNS(svgNS,'rect');
    ocean.setAttribute('width', W); ocean.setAttribute('height', H); ocean.setAttribute('fill', '#BFDCE0');
    svg.appendChild(ocean);
    const continents = [
      {cx:190, cy:150, rx:115, ry:95}, {cx:270, cy:340, rx:70, ry:115},
      {cx:500, cy:115, rx:70, ry:55}, {cx:515, cy:280, rx:90, ry:120},
      {cx:740, cy:150, rx:175, ry:110}, {cx:835, cy:365, rx:70, ry:45},
    ];
    continents.forEach(c=>{
      const el = document.createElementNS(svgNS,'ellipse');
      el.setAttribute('cx', c.cx); el.setAttribute('cy', c.cy);
      el.setAttribute('rx', c.rx); el.setAttribute('ry', c.ry);
      el.setAttribute('fill', '#E4D9BE');
      svg.appendChild(el);
    });
    getPinPos = (g)=>({x:(g.lng+180)/360*W, y:(90-g.lat)/180*H});
  }

  // Insert the base map into the DOM FIRST — getBBox() below needs the
  // element to actually be rendered/laid out to return correct results.
  wrap.innerHTML = '';
  wrap.appendChild(svg);

  // compute each country's pin position
  const positions = {};
  countryNames.forEach(name=>{ positions[name] = getPinPos(groups[name]); });

  // Some countries sit geographically very close to a neighbor (e.g.
  // Singapore right off the tip of Peninsular Malaysia, or Hong Kong/Macau
  // next to mainland China) — close enough that their name labels would
  // print right on top of each other. Rather than hand-picking pixel
  // offsets for every such pair, nudge apart any label anchors that end up
  // closer than a minimum separation (a small force-based declutter pass),
  // then draw a thin leader line from the pin to its label whenever it had
  // to move, so it's still clear which label belongs to which dot.
  const labelPositions = declutterLabelPositions(positions, countryNames, W, H);

  // populate the hub picker with the countries that actually have data,
  // preserving the current selection if it's still valid
  const hubSelect = document.getElementById('mapHubSelect');
  if(hubSelect){
    const prevValue = mapHubCountry && countryNames.includes(mapHubCountry) ? mapHubCountry : '';
    hubSelect.innerHTML = '<option value="">不显示连接线</option>' +
      countryNames.map(n=>`<option value="${n}" ${n===prevValue?'selected':''}>${escapeHtml(n)} (${groups[n].people.length})</option>`).join('');
    mapHubCountry = prevValue || null;
  }

  // draw golden root-like curved lines from the user-chosen hub country to
  // every other one — a nod to the family-tree's branches reaching around
  // the world. No lines are drawn until the user picks a hub.
  const hubName = mapHubCountry && countryNames.includes(mapHubCountry) ? mapHubCountry : null;
  if(hubName){
    const hubPos = positions[hubName];
    const linesLayer = document.createElementNS(svgNS,'g');
    linesLayer.setAttribute('opacity','0.75');
    countryNames.forEach(name=>{
      if(name===hubName) return;
      const pos = positions[name];
      const midX = (hubPos.x+pos.x)/2, midY = Math.min(hubPos.y,pos.y)-Math.abs(pos.x-hubPos.x)*0.12-10;
      const path = document.createElementNS(svgNS,'path');
      path.setAttribute('d', `M ${hubPos.x} ${hubPos.y} Q ${midX} ${midY}, ${pos.x} ${pos.y}`);
      path.setAttribute('fill','none');
      path.setAttribute('stroke','url(#rootGradient)');
      path.setAttribute('stroke-width','1.8');
      linesLayer.appendChild(path);
    });
    const defs = document.createElementNS(svgNS,'defs');
    defs.innerHTML = `<linearGradient id="rootGradient" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#B9863C"/><stop offset="100%" stop-color="#D9AE6E"/>
  </linearGradient>`;
    svg.appendChild(defs);
    svg.appendChild(linesLayer);
  }

  // pins
  countryNames.forEach(name=>{
    const g = groups[name];
    const pos = positions[name];
    const labelPos = labelPositions[name];
    const group = document.createElementNS(svgNS,'g');
    group.setAttribute('class','map-pin');
    group.setAttribute('data-country', name);

    const glow = document.createElementNS(svgNS,'circle');
    glow.setAttribute('cx', pos.x); glow.setAttribute('cy', pos.y);
    glow.setAttribute('r', name===hubName ? 13 : 10);
    glow.setAttribute('fill', 'var(--accent-2)');
    glow.setAttribute('opacity', '0.25');
    group.appendChild(glow);

    const circle = document.createElementNS(svgNS,'circle');
    circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', name===hubName ? 7 : 5.5);
    circle.setAttribute('fill', 'var(--accent-2)');
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.6');
    group.appendChild(circle);

    // if the label had to be nudged away from the pin to avoid overlapping
    // a neighbor's label, draw a thin leader line connecting the two so
    // it's still obvious which label belongs to which dot
    const displaced = Math.hypot(labelPos.x-pos.x, labelPos.y-pos.y) > 2;
    if(displaced){
      const leader = document.createElementNS(svgNS,'line');
      leader.setAttribute('x1', pos.x); leader.setAttribute('y1', pos.y);
      leader.setAttribute('x2', labelPos.x); leader.setAttribute('y2', labelPos.y-4);
      leader.setAttribute('stroke', '#B9863C');
      leader.setAttribute('stroke-width', '1');
      leader.setAttribute('opacity', '0.55');
      group.appendChild(leader);
    }

    const label = document.createElementNS(svgNS,'text');
    label.setAttribute('x', labelPos.x);
    label.setAttribute('y', labelPos.y-11);
    label.setAttribute('text-anchor','middle');
    label.setAttribute('font-size', name===hubName ? '13' : '11');
    label.setAttribute('font-weight', name===hubName ? '700' : '600');
    label.setAttribute('fill','#5B4A2F');
    label.setAttribute('stroke','#F6F1E4');
    label.setAttribute('stroke-width','3');
    label.setAttribute('paint-order','stroke');
    label.textContent = `${name} (${g.people.length})`;
    group.appendChild(label);

    group.addEventListener('click', (e)=>{
      e.stopPropagation();
      showMapPopover(name, g, {x:pos.x/W*100, y:pos.y/H*100}, outerWrap || wrap);
    });
    svg.appendChild(group);
  });

  if(mapText){
    const credit = document.createElement('div');
    credit.className = 'map-credit';
    credit.innerHTML = '地图数据：<a href="https://github.com/flekschas/simple-world-map" target="_blank" rel="noopener">flekschas/simple-world-map</a>（CC BY-SA）';
    wrap.appendChild(credit);
  }
}

function showMapPopover(countryName, group, pos, wrap){
  // v8.8: the name list is a docked panel (side of the map away from the pin;
  // below the map on narrow screens) instead of a tiny popover that could
  // run off the bottom of the dialog.
  const old = wrap.querySelector('.map-popover');
  if(old) old.remove();
  const pop = document.createElement('div');
  pop.className = 'map-popover ' + (pos && pos.x > 50 ? 'dock-left' : 'dock-right');
  const many = group.people.length > 10;
  pop.innerHTML = `
    <div class="mp-head">
      <div class="mp-title">${escapeHtml(countryName)} · ${group.people.length} 位</div>
      <button class="mp-x" type="button" title="关闭" aria-label="关闭">✕</button>
    </div>
    ${many ? '<div class="mp-search"><input type="text" placeholder="在此名单中查找…" autocomplete="off"></div>' : ''}
    <div class="mp-list">
    ${group.people.map(p=>{
      const avatarInner = photoSrc(p) ? `<img src="${escapeHtml(photoSrc(p))}" alt="">` : surnameChar(p.name);
      return `<div class="mp-person" role="button" tabindex="0" data-goto-map="${escapeHtml(p.id)}" data-name="${escapeHtml((p.name||'').toLowerCase())}"><div class="mp-avatar">${avatarInner}</div><span class="mp-name">${escapeHtml(p.name)}</span><span class="mp-go" aria-hidden="true">›</span></div>`;
    }).join('')}
    </div>
  `;
  wrap.appendChild(pop);
  const closePop = ()=> pop.remove();
  pop.querySelector('.mp-x').addEventListener('click', closePop);
  const si = pop.querySelector('.mp-search input');
  if(si){
    si.addEventListener('input', ()=>{
      const q = si.value.trim().toLowerCase();
      pop.querySelectorAll('.mp-person').forEach(el=>{
        el.style.display = (!q || el.dataset.name.includes(q)) ? '' : 'none';
      });
    });
  }
  const go = (el)=>{
    const id = el.dataset.gotoMap;
    const person = personById(id);
    document.getElementById('mapOverlay').classList.remove('show');
    if(person){
      // v8.9: same as tapping a card — focus + highlight + centre the person
      // in the generation chart, without opening the detail/edit panel.
      const tid = person.treeId || 'main';
      if(tid !== currentTreeId){
        currentTreeId = tid;
        renderTreeSelect();
        const t = trees.find(x=>x.id===tid);
        if(t) toast(`已切换到「${t.name}」`);
      }
      enterFocus(id);
      if(person.hidden) toast('此人目前被隐藏，可在「显示筛选」中恢复显示');
    }
  };
  pop.querySelectorAll('[data-goto-map]').forEach(el=>{
    el.addEventListener('click', ()=>go(el));
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); go(el); } });
  });
  // narrow screens: panel sits under the map, make sure it's in view
  if(window.matchMedia('(max-width:700px)').matches){
    try{ pop.scrollIntoView({block:'nearest', behavior:'smooth'}); }catch(e){}
  }
}

function renderHiddenPanel(){
  const list = document.getElementById('hiddenList');
  const q = (document.getElementById('filterSearch').value || '').trim().toLowerCase();
  const relevant = people.filter(p=> (p.treeId||'main')===currentTreeId || isBridgePerson(p.id));
  const items = relevant.filter(p=> !q || p.name.toLowerCase().includes(q));
  if(items.length===0){
    list.innerHTML = '<div class="none" style="padding:10px;">没有找到匹配的成员</div>';
    return;
  }
  list.innerHTML = items.map(p=>{
    const avatarInner = photoSrc(p) ? `<img src="${escapeHtml(photoSrc(p))}">` : initials(p.name);
    const kidCount = childrenOf(p.id).length;
    const bridge = isBridgePerson(p.id);
    const blockedByAncestor = !p.hidden && !bridge && !isVisible(p.id);
    return `<label class="filter-row">
      <input type="checkbox" data-toggle="${escapeHtml(p.id)}" ${p.hidden ? '' : 'checked'} ${bridge?'disabled':''}>
      <div class="mini-avatar">${avatarInner}</div>
      <div class="fname">${escapeHtml(p.name)}</div>
      ${kidCount>0 ? `<div class="fmeta">含 ${kidCount} 位后代</div>` : ''}
      ${blockedByAncestor ? `<div class="fmeta" style="color:var(--danger);">上层已收起</div>` : ''}
      ${bridge ? `<div class="fmeta">来自另一棵家族树</div>` : ''}
    </label>`;
  }).join('');
  list.querySelectorAll('[data-toggle]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      if(cb.checked) unhidePerson(cb.dataset.toggle);
      else hidePerson(cb.dataset.toggle);
    });
  });
}
function setAllVisible(visible){
  pushHistory();
  people.forEach(p=> p.hidden = !visible);
  selectedId = null;
  saveData();
  render();
  renderSidePanel();
  renderHiddenPanel();
  centerTree();
  toast(visible ? '已显示全部成员' : '已隐藏全部成员');
}

/* ============ Selection / side panel ============ */
function selectPerson(id){
  selectedId = id;
  panelOpen = true;
  render();
  renderSidePanel();
  recordNavState();
  if(isPhoneLayout()) centerOnPerson(id, true);   // v8.28: 抽屉升起后，让这个人出现在抽屉上方
}

/* v8.28: 手机上详情抽屉——在抽屉上往下划关闭（只在内容滚到最上面时才算，不抢滚动） */
(function(){
  const panel = document.getElementById('sidePanel');
  if(!panel) return;
  let startY = null, dy = 0;
  panel.addEventListener('touchstart', e=>{
    startY = (isPhoneLayout() && panel.scrollTop<=0 && e.touches.length===1) ? e.touches[0].clientY : null; dy = 0;
    panel.style.transition = 'none';
  }, {passive:true});
  panel.addEventListener('touchmove', e=>{
    if(startY===null) return;
    dy = e.touches[0].clientY - startY;
    if(dy>0) panel.style.transform = `translateY(${dy}px)`; else { panel.style.transform = ''; }
  }, {passive:true});
  const end = ()=>{
    if(startY===null) return;
    const close = dy>90; startY = null;
    panel.style.transition = 'transform .18s ease'; panel.style.transform = '';
    if(close){ const b = document.getElementById('panelCloseBtn'); if(b) b.click(); }
  };
  panel.addEventListener('touchend', end, {passive:true});
  panel.addEventListener('touchcancel', end, {passive:true});
})();

/* ============ v8.29: 辈分字谱（派字）——逻辑在 paizi.js，这里只管存取和显示 ============ */
function paiziCfg(){ const t = trees.find(x=>x.id===currentTreeId); return (t && window.Paizi && Paizi.sanitize(t.paizi)) || null; }
function paiziMap(){ const cfg = paiziCfg(); return cfg ? Paizi.compute(people, cfg) : new Map(); }
function paiziBoxHtml(p){
  const cfg = paiziCfg(); if(!cfg) return '';
  const d = Paizi.describe(p, cfg, paiziMap());
  if(!d || !d.line) return '';   // 只对父系显示
  const nums = escapeHtml(cfg.sys1) + '第 ' + d.shi + ' 世' + ((d.ru!=null && d.ru>=1) ? ' · ' + escapeHtml(cfg.sys2) + '第 ' + d.ru + ' 世' : '');
  const main = d.chars
    ? '派字「<b>' + d.chars.map(escapeHtml).join(' / ') + '</b>」' + (d.hit ? ' ✓' : ' <span class="pz-miss">（名字里没有）</span>')
    : '<span class="pz-miss">字谱里没有这一世</span>';
  return '<div class="paizi-box">' + main + '<div class="pz-sub">' + nums + '</div></div>';
}
function renderSidePanel(){
  const panel = document.getElementById('sidePanel');
  if(!selectedId || !panelOpen){ panel.classList.add('hidden'); return; }
  const p = personById(selectedId);
  if(!p){ panel.classList.add('hidden'); selectedId=null; return; }
  panel.classList.remove('hidden');

  const parents = (p.parents||[]).map(personById).filter(Boolean);
  const spouses = (p.spouses||[]).map(personById).filter(Boolean);
  const kids = childrenOf(p.id);

  function chip(person, tag){
    const avatarInner = person.photo ? `<img src="${escapeHtml(person.photo)}">` : initials(person.name);
    const hiddenTag = person.hidden ? '<span style="color:var(--danger);">（已隐藏）</span>' : '';
    return `<div class="rel-chip" data-goto="${escapeHtml(person.id)}">
      <div class="mini-avatar">${avatarInner}</div>
      <div>${escapeHtml(person.name)}${tag?` <span class="hint">（${tag}）</span>`:''}${hiddenTag}</div>
    </div>`;
  }

  panel.innerHTML = `
    <button class="panel-close-btn" id="panelCloseBtn" title="关闭详情面板">✕</button>
    <div style="position:relative; width:88px; margin:0 auto;">
      <button class="panel-hide-toggle ${p.hidden?'is-hidden':''}" data-action="quick-hide" title="${p.hidden?'显示此人':'隐藏此人'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 20c-5.5 0-9.5-4.5-11-8 .8-1.8 2.1-3.7 3.9-5.2M9.9 4.2A10.6 10.6 0 0 1 12 4c5.5 0 9.5 4.5 11 8-.5 1.1-1.2 2.3-2.1 3.4M9.5 9.5a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>
      </button>
      <div class="detail-avatar">${photoSrc(p)?`<img src="${escapeHtml(photoSrc(p))}">`:initials(p.name)}</div>
    </div>
    <div class="detail-name">${escapeHtml(p.name)} ${p.hidden?'<span style="color:var(--danger); font-size:12px; font-weight:600;">（已隐藏）</span>':''}</div>
    <div class="detail-years">${yearsLabel(p) || '　'}</div>
    ${paiziBoxHtml(p)}
    ${isBridgePerson(p.id) ? `<div class="bridge-notice" data-goto-tree-panel="${escapeHtml(p.id)}">🔗 属于「${escapeHtml((trees.find(t=>t.id===(p.treeId||'main'))||{}).name||'其他家族')}」— 点击前往查看</div>` : ''}
    ${p.notes ? `<div class="detail-notes">${escapeHtml(p.notes)}</div>` : ''}

    ${(()=>{ const k = kinInfo(p.id); if(!k) return '';
      return `<div class="kin-box"><div class="kin-title">${p.id===viewerId ? '我（当前视角）' : (k.title ? '称呼：<b>'+escapeHtml(k.title)+'</b>'+(k.std&&k.std!==k.title?' <span class="hint">（普通话：'+escapeHtml(k.std)+(k.alts&&k.alts.length?'；又作：'+escapeHtml(k.alts.join('/')):'')+'）</span>':'') : '<span class="hint">暂无称谓</span>')}</div>
        <div class="kin-chain">${escapeHtml(k.chain)}</div>${(k.ageQ && personById(k.ageQ[0]) && personById(k.ageQ[1])) ? `<div class="kin-age">「${escapeHtml(personById(k.ageQ[0]).name)}」和「${escapeHtml(personById(k.ageQ[1]).name)}」年份相同或缺失，谁更大？<br><button type="button" class="btn btn-ghost" data-elder="${escapeHtml(k.ageQ[0])}|${escapeHtml(k.ageQ[1])}">${escapeHtml(personById(k.ageQ[0]).name)} 大</button> <button type="button" class="btn btn-ghost" data-elder="${escapeHtml(k.ageQ[1])}|${escapeHtml(k.ageQ[0])}">${escapeHtml(personById(k.ageQ[1]).name)} 大</button></div>` : ''}${(k.std && !k.std.includes('/') && p.id!==viewerId) ? '<button type="button" class="btn btn-ghost" data-kin-edit="1" style="margin-top:4px; padding:2px 8px; font-size:12px;">改叫法</button>' : ''}${k.hint ? `<div class="kin-hint">${escapeHtml(k.hint)}</div>` : ''}</div>`; })()}

    <div class="detail-section-title">父母</div>
    <div class="rel-list">${parents.length? parents.map(x=>chip(x, ({step:'继',adopt:'养',god:'干'})[(p.parentTypes||{})[x.id]])).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="detail-section-title">配偶</div>
    <div class="rel-list">${spouses.length? spouses.map(x=>chip(x)).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="detail-section-title">子女</div>
    <div class="rel-list">${kids.length? kids.map(x=>chip(x)).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="quick-actions">
      <button class="btn btn-ghost" data-action="add-parent">+ 父母</button>
      <button class="btn btn-ghost" data-action="add-spouse">+ 配偶</button>
      <button class="btn btn-ghost" data-action="add-child">+ 子女</button>
      ${kids.length>0 ? `<button class="btn btn-ghost" data-action="toggle-collapse">${p.collapsed?'展开下一代':'收起下一代'}</button>` : ''}
      <button class="btn btn-ghost" data-action="set-viewer">${viewerId===p.id ? '取消「我」视角' : '设为「我」（视角）'}</button>
      <button class="btn btn-ghost" data-action="focus">${focusPersonId===p.id ? '已聚焦 · 点击退出' : '聚焦查看此人'}</button>
    </div>
    <div class="detail-footer">
      <button class="btn btn-ghost" data-action="edit">编辑</button>
      <button class="btn btn-ghost" data-action="toggle-hide">${p.hidden?'显示此人':'隐藏此人'}</button>
      <button class="btn btn-danger" data-action="delete">删除</button>
    </div>
    ${trees.length>1 ? `<button class="btn btn-ghost" data-action="move-tree" style="width:100%; margin-top:10px; justify-content:center;">移动到其他家族树…</button>` : ''}
  `;

  panel.querySelectorAll('[data-goto]').forEach(el=>{
    el.addEventListener('click', ()=>selectPerson(el.dataset.goto));
  });
  panel.querySelector('#panelCloseBtn').addEventListener('click', ()=>{
    selectedId = null;
    panelOpen = false;
    render();
    renderSidePanel();
    recordNavState();
  });
  const bridgeNotice = panel.querySelector('[data-goto-tree-panel]');
  if(bridgeNotice) bridgeNotice.addEventListener('click', ()=>goToBridgePerson(p.id));
  panel.querySelector('[data-action="edit"]').addEventListener('click', ()=>openModal(p.id));
  panel.querySelector('[data-action="delete"]').addEventListener('click', ()=>deletePerson(p.id));
  panel.querySelector('[data-action="toggle-hide"]').addEventListener('click', ()=>{
    if(p.hidden) unhidePerson(p.id); else hidePerson(p.id);
  });
  panel.querySelector('[data-action="quick-hide"]').addEventListener('click', ()=>{
    if(p.hidden) unhidePerson(p.id); else hidePerson(p.id);
  });
  panel.querySelector('[data-action="focus"]').addEventListener('click', ()=>{
    if(focusPersonId===p.id) exitFocus(); else enterFocus(p.id);
  });
  panel.querySelectorAll('[data-elder]').forEach(b=>b.addEventListener('click', ()=>{ const [x,y]=b.dataset.elder.split('|'); setElder(x,y); }));
  const kinEdit = panel.querySelector('[data-kin-edit]');
  if(kinEdit){ const k0 = kinInfo(p.id); kinEdit.addEventListener('click', ()=>editKinTitle(k0.std, (kinCustom[kinDialect]||{})[k0.std])); }
  panel.querySelector('[data-action="set-viewer"]').addEventListener('click', ()=>setViewer(p.id));
  const collapseBtn = panel.querySelector('[data-action="toggle-collapse"]');
  if(collapseBtn) collapseBtn.addEventListener('click', ()=>toggleCollapse(p.id));
  panel.querySelector('[data-action="add-parent"]').addEventListener('click', ()=>openModal(null, {presetChildOf: p.id, mode:'parent'}));
  panel.querySelector('[data-action="add-spouse"]').addEventListener('click', ()=>openModal(null, {presetSpouseOf: p.id}));
  panel.querySelector('[data-action="add-child"]').addEventListener('click', ()=>openModal(null, {presetParent: p.id}));
  const moveBtn = panel.querySelector('[data-action="move-tree"]');
  if(moveBtn) moveBtn.addEventListener('click', ()=>openMoveTreeModal(p.id));
}

/* ============ Delete ============ */
function deletePerson(id){
  const p = personById(id);
  if(!confirm(`确定要删除「${p.name}」吗？TA与其他成员的关系也会被移除，但其他成员本身不会被删除。`)) return;
  pushHistory();
  people = people.filter(x=>x.id!==id);
  people.forEach(x=>{
    if(x.parents) x.parents = x.parents.filter(pid=>pid!==id);
    if(x.spouses) x.spouses = x.spouses.filter(sid=>sid!==id);
  });
  if(selectedId===id) selectedId=null;
  saveData();
  render();
  renderSidePanel();
  toast('已删除 ' + p.name);
  // The deleted person's photo (if any) may now be orphaned — but the
  // pushHistory() above means it's still reachable via undo, so don't
  // delete it outright; let gcOrphanedPhotos() decide (it checks the undo
  // stack too, and only actually removes what nothing can reach anymore).
  gcOrphanedPhotos();
}

/* ============ Modal (add/edit) ============ */
let modalPhotoId = null;
let modalPreset = {};

function openModal(id, preset){
  editingId = id;
  modalPreset = preset || {};
  modalPhotoId = null;
  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalTitle').textContent = id ? '编辑成员' : '添加成员';
  document.getElementById('fName').value = '';
  document.getElementById('fBirth').value = '';
  document.getElementById('fDeath').value = '';
  document.getElementById('fCountry').value = '';
  document.getElementById('fOrder').value = '';
  document.getElementById('fNotes').value = '';
  document.getElementById('photoPreview').innerHTML = '👤';
  document.querySelectorAll('input[name=gender]').forEach(r=>r.checked = r.value==='M');

  modalParentTypes = {};
  populateMultiSelect('parentsSelect', people, [], 4);
  populateMultiSelect('spousesSelect', people, [], 99);

  if(id){
    const p = personById(id);
    document.getElementById('fName').value = p.name || '';
    document.getElementById('fBirth').value = p.birth || '';
    document.getElementById('fDeath').value = p.death || '';
    document.getElementById('fCountry').value = p.country || '';
    document.getElementById('fOrder').value = p.birthOrder ? String(p.birthOrder) : '';
    document.getElementById('fNotes').value = p.notes || '';
    modalPhotoId = p.photoId || null;
    if(photoSrc(p)) document.getElementById('photoPreview').innerHTML = `<img src="${escapeHtml(photoSrc(p))}">`;
    document.querySelectorAll('input[name=gender]').forEach(r=>r.checked = r.value===p.gender);
    modalParentTypes = Object.assign({}, p.parentTypes||{});
    populateMultiSelect('parentsSelect', people.filter(x=>x.id!==id), p.parents||[], 4);
    populateMultiSelect('spousesSelect', people.filter(x=>x.id!==id), p.spouses||[], 99);
  } else if(modalPreset.presetParent){
    populateMultiSelect('parentsSelect', people, [modalPreset.presetParent], 4);
  }

  renderParentTypes();
  overlay.classList.add('show');
  document.getElementById('fName').focus();
}

/* ===== v8.11+: 父母关系类型（亲生 / 继 / 养），记在 person.parentTypes 上 ===== */
let modalParentTypes = {};
function renderParentTypes(){
  const row = document.getElementById('parentTypesRow');
  if(!row) return;
  const ids = Array.from(document.querySelectorAll('#parentsSelect input:checked')).map(i=>i.value);
  if(!ids.length){ row.innerHTML=''; return; }
  row.innerHTML = '<div class="hint" style="margin:6px 0 2px;">与每位父母的关系（影响称谓，如继母、养父、干爹）：</div>' + ids.map(id=>{
    const p = personById(id); if(!p) return '';
    const cur = modalParentTypes[id] || '';
    return `<label class="ptype"><span>${escapeHtml(p.name)}</span>
      <select data-ptype="${escapeHtml(id)}">
        <option value=""${cur===''?' selected':''}>亲生</option>
        <option value="step"${cur==='step'?' selected':''}>继（继父/继母）</option>
        <option value="adopt"${cur==='adopt'?' selected':''}>养（养父/养母）</option>
        <option value="god"${cur==='god'?' selected':''}>干（干爹/干妈 · 契爷/契娘）</option>
      </select></label>`;
  }).join('');
  row.querySelectorAll('select[data-ptype]').forEach(s=>{
    s.addEventListener('change', ()=>{ modalParentTypes[s.dataset.ptype] = s.value; });
  });
}
function collectParentTypes(parentIds){
  const out = {};
  parentIds.forEach(id=>{ const t = modalParentTypes[id]; if(t==='step'||t==='adopt'||t==='god') out[id]=t; });
  return Object.keys(out).length ? out : undefined;
}
document.getElementById('parentsSelect').addEventListener('change', ()=>setTimeout(renderParentTypes,0));

function populateMultiSelect(containerId, list, selectedIds, max){
  const el = document.getElementById(containerId);
  if(list.length===0){ el.innerHTML = '<div class="none">暂无其他成员可选</div>'; return; }
  el.innerHTML = list.map(p=>`
    <label>
      <input type="checkbox" value="${escapeHtml(p.id)}" ${selectedIds.includes(p.id)?'checked':''}>
      <span>${escapeHtml(p.name)}</span>
    </label>
  `).join('');
  if(max && max<99){
    el.onchange = (event)=>{
      const checked = el.querySelectorAll('input:checked');
      if(checked.length>max){
        event.target.checked = false;
        toast(`最多选择 ${max} 位`);
      }
    };
  } else {
    el.onchange = null;
  }
}

function quickAddPerson(name, containerId, max){
  name = name.trim();
  if(!name){ toast('请先输入姓名'); return; }
  pushHistory();
  const newPerson = { id:uid(), name, gender:'O', birth:'', death:'', notes:'', photo:null, parents:[], spouses:[], treeId: currentTreeId };
  people.push(newPerson);
  saveData();

  const checked = Array.from(document.querySelectorAll('#'+containerId+' input:checked')).map(i=>i.value);
  if(max && max<99 && checked.length>=max){
    toast(`已新建「${name}」，但父母已选满 ${max} 位，请先取消勾选一位再选择TA`);
  } else {
    checked.push(newPerson.id);
  }
  const excludeId = editingId;
  const list = people.filter(p=>p.id!==excludeId);
  populateMultiSelect(containerId, list, checked, max);
  if(containerId==='parentsSelect') renderParentTypes();
  toast('已新建 ' + name);
  return newPerson.id;
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
  editingId = null;
  modalPreset = {};
  modalPhotoId = null;
}

function cancelModal(){
  // User backed out (✕ / Cancel / clicked the overlay) instead of saving.
  // If they'd picked a new photo during this session, it was already
  // uploaded to IndexedDB by the fPhoto handler (for the live preview) but
  // never got attached to a person's record — gcOrphanedPhotos() will see
  // it's unreferenced anywhere (current people or undo history) and sweep
  // it. The original photo, if editing an existing person, was never
  // touched, so this is a no-op in the normal "opened, looked, closed" case.
  closeModal();
  gcOrphanedPhotos();
}

function saveModal(){
  const name = document.getElementById('fName').value.trim();
  if(!name){ toast('请填写姓名'); return; }
  pushHistory();
  const gender = document.querySelector('input[name=gender]:checked').value;
  const birth = document.getElementById('fBirth').value.trim();
  const death = document.getElementById('fDeath').value.trim();
  const country = document.getElementById('fCountry').value.trim();
  const notes = document.getElementById('fNotes').value.trim();
  const birthOrder = parseInt(document.getElementById('fOrder').value, 10) || undefined;
  const parentIds = Array.from(document.querySelectorAll('#parentsSelect input:checked')).map(i=>i.value);
  const spouseIds = Array.from(document.querySelectorAll('#spousesSelect input:checked')).map(i=>i.value);

  if(editingId){
    const p = personById(editingId);
    // clean old spouse links then relink
    people.forEach(x=>{ if(x.spouses) x.spouses = x.spouses.filter(id=>id!==editingId); });
    p.name=name; p.gender=gender; p.birth=birth; p.death=death; p.country=country; p.notes=notes; p.birthOrder=birthOrder;
    p.photoId = modalPhotoId;
    p.parents = parentIds;
    p.parentTypes = collectParentTypes(parentIds);
    p.spouses = spouseIds;
    spouseIds.forEach(sid=>{
      const sp = personById(sid);
      if(sp){ sp.spouses = sp.spouses||[]; if(!sp.spouses.includes(editingId)) sp.spouses.push(editingId); }
    });
    saveData(); render(); renderSidePanel();
    toast('已更新 ' + name);
  } else {
    const newId = uid();
    const newPerson = { id:newId, name, gender, birth, death, country, notes, birthOrder, photoId: modalPhotoId, parents: parentIds, parentTypes: collectParentTypes(parentIds), spouses: spouseIds, treeId: currentTreeId };
    people.push(newPerson);
    spouseIds.forEach(sid=>{
      const sp = personById(sid);
      if(sp){ sp.spouses = sp.spouses||[]; if(!sp.spouses.includes(newId)) sp.spouses.push(newId); }
    });
    if(modalPreset.presetSpouseOf){
      const sp = personById(modalPreset.presetSpouseOf);
      if(sp){
        sp.spouses = sp.spouses||[]; if(!sp.spouses.includes(newId)) sp.spouses.push(newId);
        newPerson.spouses.push(sp.id);
      }
    }
    if(modalPreset.presetChildOf){
      const child = personById(modalPreset.presetChildOf);
      if(child){ child.parents = child.parents||[]; if(!child.parents.includes(newId)) child.parents.push(newId); }
    }
    selectedId = newId;
    saveData(); render(); renderSidePanel();
    toast('已添加 ' + name);
  }
  closeModal();
  // If editing replaced an existing photo with a different one, the old
  // blob may now be orphaned — but pushHistory() above means the old
  // photoId is still reachable via undo, so let gcOrphanedPhotos() decide;
  // it won't touch anything still sitting in the undo stack.
  gcOrphanedPhotos();
}

/* ============ Search ============ */
function handleSearch(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const box = document.getElementById('searchResults');
  if(!q){ box.classList.remove('show'); box.innerHTML=''; return; }
  const matches = people.filter(p=>p.name.toLowerCase().includes(q)).slice(0,8);
  if(matches.length===0){
    box.innerHTML = `<div class="search-item" style="color:var(--ink-soft)">未找到匹配成员</div><div class="search-item search-add" data-add-name="${escapeHtml(q)}">＋ 没找到？添加「${escapeHtml(document.getElementById('searchInput').value.trim())}」</div>`;
    box.classList.add('show');
    box.querySelector('[data-add-name]').addEventListener('click', ()=>{
      const name = document.getElementById('searchInput').value.trim();
      box.classList.remove('show');
      document.getElementById('searchInput').value='';
      openModal(null);
      document.getElementById('fName').value = name;
    });
    return;
  }
  box.innerHTML = matches.map(p=>{
    const avatarInner = photoSrc(p) ? `<img style="width:100%;height:100%;object-fit:cover;border-radius:50%;" src="${escapeHtml(photoSrc(p))}">` : '';
    const hiddenTag = p.hidden ? ' <span style="color:var(--danger); font-size:11px;">（已隐藏）</span>' : '';
    const otherTree = (p.treeId||'main')!==currentTreeId ? ` <span style="color:var(--accent); font-size:11px;">（${escapeHtml((trees.find(t=>t.id===(p.treeId||'main'))||{}).name||'其他家族')}）</span>` : '';
    return `<div class="search-item" data-id="${escapeHtml(p.id)}"><span style="width:20px;height:20px;border-radius:50%;background:var(--bg-alt);display:inline-flex;align-items:center;justify-content:center;font-size:10px;overflow:hidden;">${avatarInner || initials(p.name)}</span>${escapeHtml(p.name)}${otherTree}${hiddenTag}</div>`;
  }).join('');
  box.classList.add('show');
  box.querySelectorAll('[data-id]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const person = personById(el.dataset.id);
      box.classList.remove('show');
      document.getElementById('searchInput').value='';
      const personTree = person ? (person.treeId||'main') : currentTreeId;
      if(personTree!==currentTreeId){
        currentTreeId = personTree;
        saveData();
        renderTreeSelect();
      }
      selectPerson(el.dataset.id);
      if(!person.hidden) focusOn(el.dataset.id);
    });
  });
}
function focusOn(id){
  centerOnPerson(id);
}

/* ============ Zoom / Pan ============ */
/* v8.24: 世代标签（"第 N 代"）原本贴在每一排最左端，画面往右拖后会跑出屏幕；
   这里让它们始终贴在可视区域左边缘（聚焦时让开左侧快捷按钮） */
function stickGenLabels(){
  const canvas = document.getElementById('canvas'), wrapEl = document.getElementById('canvasWrap');
  if(!canvas || !wrapEl) return;
  const cr = canvas.getBoundingClientRect(), wr = wrapEl.getBoundingClientRect();
  const bars = ['quickUp','quickDown'].map(id=>document.getElementById(id)).filter(q=>q && q.offsetParent!==null).map(q=>q.getBoundingClientRect());
  canvas.querySelectorAll('.gen-label').forEach(l=>{
    const cur = parseFloat(l.dataset.shift || '0');
    const r = l.getBoundingClientRect();
    // 只有与左侧快捷按钮在纵向上重叠的那几排，才需要让开按钮
    let margin = 8;
    bars.forEach(b=>{ if(r.top < b.bottom && r.bottom > b.top) margin = Math.max(margin, b.right - wr.left + 6); });
    const base = (r.left - cr.left) / zoom - cur;
    const shift = Math.max(0, ((wr.left - cr.left) + margin) / zoom - base);
    if(Math.abs(shift-cur) > 0.5){ l.style.transform = `translateX(${shift}px)`; l.dataset.shift = shift; }
  });
}
const _renderBase = render;
render = function(){ const r = _renderBase.apply(this, arguments); stickGenLabels(); return r; };
function applyTransform(){
  document.getElementById('canvas').style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  stickGenLabels();
  document.getElementById('zoomReset').textContent = Math.round(zoom*100)+'%';
  scheduleSaveViewState();
}
document.getElementById('zoomIn').addEventListener('click', ()=>{ zoom=Math.min(2, zoom+0.1); applyTransform(); });
document.getElementById('zoomOut').addEventListener('click', ()=>{ zoom=Math.max(0.3, zoom-0.1); applyTransform(); });
document.getElementById('zoomReset').addEventListener('click', ()=>{ zoom=1; applyTransform(); centerTree(); });

const wrap = document.getElementById('canvasWrap');
wrap.addEventListener('mousedown', (e)=>{
  if(e.target.closest('.card, .quick-bar, .fab-col, .zoom-controls')) return;
  panState = {startX:e.clientX, startY:e.clientY, origX:pan.x, origY:pan.y};
  wrap.style.cursor='grabbing';
});
window.addEventListener('mousemove', (e)=>{
  if(!panState) return;
  pan.x = panState.origX + (e.clientX-panState.startX);
  pan.y = panState.origY + (e.clientY-panState.startY);
  applyTransform();
});
window.addEventListener('mouseup', ()=>{ panState=null; wrap.style.cursor='default'; });
wrap.addEventListener('wheel', (e)=>{
  e.preventDefault();
  zoom = Math.min(2, Math.max(0.3, zoom - e.deltaY*0.0015));
  applyTransform();
}, {passive:false});

// basic touch pan/pinch
let touchState=null;
wrap.addEventListener('touchstart', (e)=>{
  if(e.target.closest('.card, .quick-bar, .fab-col, .zoom-controls')) return;
  if(e.touches.length===1){
    touchState={mode:'pan', startX:e.touches[0].clientX, startY:e.touches[0].clientY, origX:pan.x, origY:pan.y};
  } else if(e.touches.length===2){
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    touchState={mode:'pinch', startDist:Math.hypot(dx,dy), startZoom:zoom};
  }
}, {passive:true});
wrap.addEventListener('touchmove', (e)=>{
  if(!touchState) return;
  if(touchState.mode==='pan' && e.touches.length===1){
    pan.x = touchState.origX + (e.touches[0].clientX-touchState.startX);
    pan.y = touchState.origY + (e.touches[0].clientY-touchState.startY);
    applyTransform();
  } else if(touchState.mode==='pinch' && e.touches.length===2){
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    const dist=Math.hypot(dx,dy);
    zoom = Math.min(2, Math.max(0.3, touchState.startZoom * (dist/touchState.startDist)));
    applyTransform();
  }
}, {passive:true});
wrap.addEventListener('touchend', ()=>{ touchState=null; });

/* ============ Export / Import ============ */
function computeExportScope(scopeTreeId){
  if(!scopeTreeId) return { trees, people };
  const scopedPeople = [];
  const idsIncluded = new Set();
  people.forEach(p=>{
    if((p.treeId||'main')===scopeTreeId){ scopedPeople.push(p); idsIncluded.add(p.id); }
  });
  // include direct bridge spouses (one hop) so relationships don't dangle —
  // but not the rest of THEIR tree, keeping the export scoped to just this family
  const bridgeIds = new Set();
  scopedPeople.forEach(p=>{
    (p.spouses||[]).forEach(sid=>{ if(!idsIncluded.has(sid)) bridgeIds.add(sid); });
  });
  bridgeIds.forEach(id=>{
    const p = personById(id);
    if(p) scopedPeople.push(p);
  });
  const treeMeta = trees.find(t=>t.id===scopeTreeId);
  return { trees: treeMeta ? [treeMeta] : DEFAULT_TREES.slice(), people: scopedPeople };
}

/* ---- Standalone export encryption (separate from the app-lock passcode) ----
   Envelope layout: magic bytes "FTZENC1\n" (8) + salt (16) + iv (12) + AES-GCM ciphertext.
   Uses the same PBKDF2 + AES-GCM primitives as the app lock, but with its own
   password chosen at export time — decrypting an export never requires or
   reveals the app-lock passcode. */
const EXPORT_ENC_MAGIC = new TextEncoder().encode('FTZENC1\n'); // 8 bytes
async function encryptExportBytes(passcode, plainBytes){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPasscode(passcode, salt);
  const combined = await encryptBytes(key, plainBytes); // iv(12) + ciphertext
  const out = new Uint8Array(EXPORT_ENC_MAGIC.length + salt.length + combined.length);
  out.set(EXPORT_ENC_MAGIC, 0);
  out.set(salt, EXPORT_ENC_MAGIC.length);
  out.set(combined, EXPORT_ENC_MAGIC.length + salt.length);
  return out;
}
async function decryptExportBytes(passcode, envelopeBytes){
  const magic = envelopeBytes.slice(0, EXPORT_ENC_MAGIC.length);
  const isKnown = magic.length===EXPORT_ENC_MAGIC.length && magic.every((b,i)=>b===EXPORT_ENC_MAGIC[i]);
  if(!isKnown) throw new Error('不是加密的导出文件');
  const salt = envelopeBytes.slice(EXPORT_ENC_MAGIC.length, EXPORT_ENC_MAGIC.length+16);
  const combined = envelopeBytes.slice(EXPORT_ENC_MAGIC.length+16);
  const key = await deriveKeyFromPasscode(passcode, salt);
  try{
    return await decryptBytes(key, combined); // throws if passcode is wrong (AES-GCM auth tag check)
  }catch(e){
    throw new Error('密码错误，无法解密');
  }
}

async function exportData(scopeTreeId, encryptPasscode){
  toast('正在打包导出…');
  try{
    const zip = new JSZip();
    const { trees: exportTrees, people: exportPeople } = computeExportScope(scopeTreeId);
    const payload = { trees: exportTrees, people: exportPeople };
    zip.file('data.json', JSON.stringify(payload, null, 2));

    const photoIds = new Set();
    exportPeople.forEach(p=>{ if(p.photoId) photoIds.add(p.photoId); });
    const photosFolder = zip.folder('photos');
    for(const photoId of photoIds){
      try{
        const blob = await getPhotoBlob(photoId);
        if(blob) photosFolder.file(photoId + '.jpg', blob);
      }catch(e){}
    }

    const zipBlob = await zip.generateAsync({type:'blob'});
    const label = scopeTreeId ? (exportTrees[0].name || '家族树').replace(/[\\/:*?"<>|]+/g,'-') : 'family-tree';
    const dateStr = new Date().toISOString().slice(0,10);

    let outBlob, filename;
    if(encryptPasscode){
      const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
      const envelope = await encryptExportBytes(encryptPasscode, zipBytes);
      outBlob = new Blob([envelope], {type:'application/octet-stream'});
      filename = label + '-' + dateStr + '.ftenc';
    } else {
      outBlob = zipBlob;
      filename = label + '-' + dateStr + '.zip';
    }

    const url = URL.createObjectURL(outBlob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast(encryptPasscode ? '已导出加密文件（含照片）' : '已导出 ZIP 文件（含照片）');
  }catch(err){
    toast('导出失败：' + err.message);
  }
}

const IMPORT_LIMITS = {
  maxPeople: 20000,
  maxTrees: 200,
  maxParentsPerPerson: 4,
  maxPhotoFiles: 5000,
  maxPhotoBytes: 15 * 1024 * 1024, // 15MB per photo file
  allowedPhotoExt: /\.(jpe?g|png|webp|gif)$/i,
};

function importStr(v, fallback){
  return (typeof v === 'string') ? v : (fallback===undefined ? '' : fallback);
}

// Imported data (a ZIP or .ftenc someone else sent you) is untrusted input.
// This walks the raw JSON field-by-field, coercing wrong types to safe
// defaults and dropping anything that isn't recognized, rather than trusting
// the shape blindly. It can't be used for XSS (all rendering already goes
// through escapeHtml/dataset), but malformed data — wrong types, missing
// ids, relationship references to nobody, a runaway record count — could
// otherwise crash rendering or hang the tab.
function validateAndNormalizePeople(rawPeople){
  if(!Array.isArray(rawPeople)) throw new Error('格式错误：people 字段不是数组');
  if(rawPeople.length > IMPORT_LIMITS.maxPeople){
    throw new Error(`导入的成员数量（${rawPeople.length}）超过上限 ${IMPORT_LIMITS.maxPeople}，请拆分后再导入`);
  }
  const seenIds = new Set();
  const cleaned = [];
  for(const raw of rawPeople){
    if(!raw || typeof raw !== 'object') continue; // skip entries that aren't objects at all
    let id = importStr(raw.id);
    if(!id || seenIds.has(id)) id = uid(); // missing/duplicate id -> assign a fresh one
    seenIds.add(id);
    const gender = (raw.gender==='M' || raw.gender==='F') ? raw.gender : 'O';
    cleaned.push({
      id,
      name: importStr(raw.name, '未命名'),
      gender,
      birth: importStr(raw.birth),
      death: importStr(raw.death),
      notes: importStr(raw.notes),
      country: importStr(raw.country) || undefined,
      birthOrder: (Number.isInteger(raw.birthOrder) && raw.birthOrder>=1 && raw.birthOrder<=30) ? raw.birthOrder : undefined,
      photo: importStr(raw.photo) || null,
      photoId: importStr(raw.photoId) || undefined,
      parents: Array.isArray(raw.parents) ? raw.parents.filter(x=>typeof x==='string').slice(0, IMPORT_LIMITS.maxParentsPerPerson) : [],
      spouses: Array.isArray(raw.spouses) ? raw.spouses.filter(x=>typeof x==='string') : [],
      treeId: importStr(raw.treeId) || undefined,
      hidden: !!raw.hidden,
      collapsed: !!raw.collapsed,
      elder: Array.isArray(raw.elder) ? raw.elder.filter(x=>typeof x==='string').slice(0,50) : undefined,
      parentTypes: (raw.parentTypes && typeof raw.parentTypes==='object' && !Array.isArray(raw.parentTypes)) ? Object.fromEntries(Object.entries(raw.parentTypes).filter(([k,v])=>(v==='step'||v==='adopt'||v==='god')).slice(0,8)) : undefined,
      orderHints: (raw.orderHints && typeof raw.orderHints==='object' && !Array.isArray(raw.orderHints)) ? raw.orderHints : undefined,
    });
  }
  // Second pass: relationship ids must point at someone who actually exists
  // in this import, or dangling references would break rendering later.
  const validIds = new Set(cleaned.map(p=>p.id));
  cleaned.forEach(p=>{
    p.parents = p.parents.filter(id=>validIds.has(id));
    p.spouses = p.spouses.filter(id=>validIds.has(id));
  });
  return cleaned;
}

function validateAndNormalizeTrees(rawTrees){
  if(!Array.isArray(rawTrees) || !rawTrees.length) return DEFAULT_TREES.slice();
  const cleaned = rawTrees
    .slice(0, IMPORT_LIMITS.maxTrees)
    .filter(t=>t && typeof t==='object' && typeof t.id==='string' && t.id)
    .map(t=>{ const o = { id: t.id, name: importStr(t.name, t.id) }; const pz = window.Paizi && Paizi.sanitize(t.paizi); if(pz) o.paizi = pz; return o; });
  return cleaned.length ? cleaned : DEFAULT_TREES.slice();
}

async function applyImportedData(data){
  if(Array.isArray(data)){
    // legacy format: a plain people array, single tree
    people = validateAndNormalizePeople(data);
    trees = DEFAULT_TREES.slice();
    currentTreeId = 'main';
  } else if(data && Array.isArray(data.people)){
    people = validateAndNormalizePeople(data.people);
    trees = validateAndNormalizeTrees(data.trees);
    currentTreeId = trees[0].id;
  } else {
    throw new Error('格式错误');
  }
  await migrateLegacyPhotos(); // in case the imported JSON still has old base64 photo fields
  selectedId = null;
  focusPersonId = null;
  saveData(); renderTreeSelect(); render(); renderSidePanel(); centerTree();
  toast('导入成功，共 ' + people.length + ' 位成员');
}

async function importZipBytes(zipBytesOrFile){
  const zip = await JSZip.loadAsync(zipBytesOrFile);
  const dataFile = zip.file('data.json');
  if(!dataFile) throw new Error('压缩包内找不到 data.json');
  const jsonText = await dataFile.async('string');
  const data = JSON.parse(jsonText);
  // restore photos into IndexedDB before applying data, so photoCache is ready by render time
  const photoJobs = [];
  const photosFolder = zip.folder('photos');
  let photoFileCount = 0, skippedPhotos = 0;
  if(photosFolder){
    photosFolder.forEach((relPath, fileEntry)=>{
      if(fileEntry.dir) return;
      // Guard against a malicious/corrupt zip trying to hang or crash the
      // tab: cap how many photo entries we'll process, only accept known
      // image extensions, and reject anything absurdly large per-file.
      if(photoFileCount >= IMPORT_LIMITS.maxPhotoFiles){ skippedPhotos++; return; }
      if(!IMPORT_LIMITS.allowedPhotoExt.test(relPath)){ skippedPhotos++; return; }
      photoFileCount++;
      photoJobs.push((async ()=>{
        // _data.uncompressedSize is populated by JSZip from the zip's local
        // file header, so we can check size before decompressing the blob.
        const declaredSize = fileEntry._data && fileEntry._data.uncompressedSize;
        if(typeof declaredSize === 'number' && declaredSize > IMPORT_LIMITS.maxPhotoBytes){ skippedPhotos++; return; }
        const blob = await fileEntry.async('blob');
        if(blob.size > IMPORT_LIMITS.maxPhotoBytes){ skippedPhotos++; return; }
        const photoId = relPath.replace(/\.[a-zA-Z0-9]+$/, '');
        await putPhotoBlob(photoId, blob);
        photoCache[photoId] = URL.createObjectURL(blob);
      })());
    });
  }
  await Promise.all(photoJobs);
  await applyImportedData(data);
  if(skippedPhotos > 0){
    toast(`已跳过 ${skippedPhotos} 个不符合要求的照片文件（过大或格式不支持）`);
  }
}

function promptImportPasscode(){
  return new Promise((resolve)=>{
    const overlay = document.getElementById('importPasscodeOverlay');
    const input = document.getElementById('importPasscodeInput');
    const closeBtn = document.getElementById('importPasscodeClose');
    const cancelBtn = document.getElementById('importPasscodeCancel');
    const confirmBtn = document.getElementById('importPasscodeConfirm');

    let settled = false;
    function cleanup(){
      overlay.classList.remove('show');
      input.value = '';
      closeBtn.removeEventListener('click', onCancel);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      overlay.removeEventListener('click', onOverlayClick);
      input.removeEventListener('keydown', onKeydown);
    }
    function onCancel(){
      if(settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }
    function onConfirm(){
      if(settled) return;
      settled = true;
      const val = input.value;
      cleanup();
      resolve(val || null);
    }
    function onOverlayClick(e){
      if(e.target === overlay) onCancel();
    }
    function onKeydown(e){
      if(e.key === 'Enter') onConfirm();
      else if(e.key === 'Escape') onCancel();
    }

    closeBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    overlay.addEventListener('click', onOverlayClick);
    input.addEventListener('keydown', onKeydown);

    overlay.classList.add('show');
    input.focus();
  });
}

function importData(file){
  pushHistory();
  const lowerName = file.name.toLowerCase();
  if(lowerName.endsWith('.ftenc')){
    promptImportPasscode().then(async (passcode)=>{
      if(!passcode){ toast('已取消导入'); return; }
      try{
        const buf = await file.arrayBuffer();
        const envelopeBytes = new Uint8Array(buf);
        const zipBytes = await decryptExportBytes(passcode, envelopeBytes);
        await importZipBytes(zipBytes);
      }catch(err){
        toast('导入失败：' + (err.message || '密码错误或文件已损坏'));
      }
    });
  } else if(lowerName.endsWith('.zip')){
    importZipBytes(file).catch(err=>{
      toast('导入失败：' + (err.message || '文件格式不正确'));
    });
  } else {
    const reader = new FileReader();
    reader.onload = (e)=>{
      try{
        const data = JSON.parse(e.target.result);
        applyImportedData(data);
      }catch(err){
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }
}

/* ============ Wire up UI ============ */
document.getElementById('addRootBtn').addEventListener('click', ()=>openModal(null));
document.getElementById('emptyAddBtn').addEventListener('click', ()=>openModal(null));
document.getElementById('modalClose').addEventListener('click', cancelModal);
document.getElementById('cancelBtn').addEventListener('click', cancelModal);
document.getElementById('saveBtn').addEventListener('click', saveModal);
document.getElementById('modalOverlay').addEventListener('click', (e)=>{ if(e.target.id==='modalOverlay') cancelModal(); });
document.getElementById('searchInput').addEventListener('input', handleSearch);
document.getElementById('searchInput').addEventListener('keydown', (e)=>{
  const box = document.getElementById('searchResults');
  const items = Array.from(box.querySelectorAll('.search-item')).filter(el=>el.dataset.id || el.dataset.addName);
  if(!box.classList.contains('show') || !items.length) return;
  let idx = items.findIndex(el=>el.classList.contains('active'));
  if(e.key==='ArrowDown' || e.key==='ArrowUp'){
    e.preventDefault();
    idx = e.key==='ArrowDown' ? (idx+1)%items.length : (idx<=0 ? items.length-1 : idx-1);
    items.forEach(el=>el.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({block:'nearest'});
  } else if(e.key==='Enter'){
    e.preventDefault();
    (items[idx>=0?idx:0]).click();
  } else if(e.key==='Escape'){
    box.classList.remove('show');
  }
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.search-wrap')) document.getElementById('searchResults').classList.remove('show');
});
document.getElementById('fPhoto').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const blob = await resizeImageToBlob(file);
    const photoId = uid();
    await putPhotoBlob(photoId, blob);
    const objectUrl = URL.createObjectURL(blob);
    photoCache[photoId] = objectUrl;
    const previousPick = modalPhotoId;
    modalPhotoId = photoId;
    document.getElementById('photoPreview').innerHTML = `<img src="${objectUrl}">`;
    // If this replaces a photo picked earlier in the same still-unsaved
    // session, that earlier upload is now orphaned (it was never attached
    // to a saved person). gcOrphanedPhotos() will confirm that and sweep it.
    if(previousPick) gcOrphanedPhotos();
  }catch(err){
    toast('照片处理失败，请换一张试试');
  }
});
document.getElementById('parentQuickAdd').addEventListener('click', ()=>{
  const input = document.getElementById('parentQuickName');
  quickAddPerson(input.value, 'parentsSelect', 4);
  input.value='';
});
document.getElementById('parentQuickName').addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); document.getElementById('parentQuickAdd').click(); }
});
document.getElementById('spouseQuickAdd').addEventListener('click', ()=>{
  const input = document.getElementById('spouseQuickName');
  quickAddPerson(input.value, 'spousesSelect', 99);
  input.value='';
});
document.getElementById('spouseQuickName').addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); document.getElementById('spouseQuickAdd').click(); }
});
document.getElementById('mapBtn').addEventListener('click', ()=>{
  renderMapView();
  document.getElementById('mapOverlay').classList.add('show');
});
document.getElementById('mapHubSelect').addEventListener('change', (e)=>{
  mapHubCountry = e.target.value || null;
  renderMapView();
});
document.getElementById('mapClose').addEventListener('click', ()=>{
  document.getElementById('mapOverlay').classList.remove('show');
});
document.getElementById('mapOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='mapOverlay') document.getElementById('mapOverlay').classList.remove('show');
});
document.getElementById('mapCanvasOuter').addEventListener('click', (e)=>{
  if(!e.target.closest('.map-pin') && !e.target.closest('.map-popover')){
    const pop = document.querySelector('#mapCanvasOuter .map-popover');
    if(pop) pop.remove();
  }
});
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape'){ const pop = document.querySelector('#mapCanvasOuter .map-popover'); if(pop) pop.remove(); }
});
document.getElementById('helpBtn').addEventListener('click', ()=>{
  document.getElementById('helpOverlay').classList.add('show');
});
document.getElementById('helpClose').addEventListener('click', ()=>{
  document.getElementById('helpOverlay').classList.remove('show');
});
document.getElementById('helpOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='helpOverlay') document.getElementById('helpOverlay').classList.remove('show');
});
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('lockNowBtn').addEventListener('click', ()=>{
  if(confirm('立即锁定应用？需要重新输入密码才能继续使用。')){
    location.reload();
  }
});
document.getElementById('changePasscodeBtn').addEventListener('click', ()=>{
  document.getElementById('cpOldInput').value='';
  document.getElementById('cpNewInput').value='';
  document.getElementById('cpConfirmInput').value='';
  document.getElementById('cpError').style.display='none';
  document.getElementById('changePasscodeOverlay').classList.add('show');
});
document.getElementById('changePasscodeClose').addEventListener('click', ()=>{
  document.getElementById('changePasscodeOverlay').classList.remove('show');
});
document.getElementById('cpCancel').addEventListener('click', ()=>{
  document.getElementById('changePasscodeOverlay').classList.remove('show');
});
document.getElementById('cpConfirm').addEventListener('click', async ()=>{
  const oldPass = document.getElementById('cpOldInput').value;
  const newPass = document.getElementById('cpNewInput').value;
  const confirmPass = document.getElementById('cpConfirmInput').value;
  const errEl = document.getElementById('cpError');
  errEl.style.display='none';
  if(!newPass || newPass.length<6){ errEl.textContent='新密码至少需要6位'; errEl.style.display='block'; return; }
  if(newPass!==confirmPass){ errEl.textContent='两次输入的新密码不一致'; errEl.style.display='block'; return; }
  const btn = document.getElementById('cpConfirm');
  btn.disabled=true; btn.textContent='更改中…';
  try{
    await changePasscode(oldPass, newPass);
    btn.disabled=false; btn.textContent='确认更改';
    document.getElementById('changePasscodeOverlay').classList.remove('show');
    toast('密码已更改');
  }catch(e){
    btn.disabled=false; btn.textContent='确认更改';
    errEl.textContent = e.message || '更改失败';
    errEl.style.display='block';
  }
});
document.getElementById('changePasscodeOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='changePasscodeOverlay') document.getElementById('changePasscodeOverlay').classList.remove('show');
});
document.addEventListener('keydown', (e)=>{
  const key = e.key ? e.key.toLowerCase() : '';
  if((e.ctrlKey||e.metaKey) && key==='z' && !e.shiftKey){
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if(tag==='input' || tag==='textarea') return; // let normal text-field undo work
    e.preventDefault();
    undo();
  }
});
document.getElementById('treeSelect').addEventListener('change', (e)=>switchTree(e.target.value));
/* ---- 辈分字谱设置窗口 ---- */
(function(){
  const $ = id=>document.getElementById(id);
  const ov = $('paiziOverlay');
  function curSeq(){ return Paizi.parseSeq($('paiziSeq').value); }
  function refreshShi(keep){
    const seq = curSeq(), s1 = parseInt($('paiziStart1').value,10);
    const sel = $('paiziAnchorShi'), prev = keep!==undefined ? keep : sel.value;
    sel.innerHTML = '<option value="">（未选）</option>';
    if(seq.length && s1>=1) seq.forEach((s,i)=>{ const o = document.createElement('option'); o.value = String(s1+i); o.textContent = (s1+i) + ' 世　' + s.split('|').join(' / '); sel.appendChild(o); });
    if(prev && Array.from(sel.options).some(o=>o.value===String(prev))) sel.value = String(prev);
    $('paiziSeqInfo').textContent = seq.length ? '共 ' + seq.length + ' 代' + (s1>=1 ? '（第 ' + s1 + ' – ' + (s1+seq.length-1) + ' 世）' : '') : '';
  }
  function openPaizi(){
    const cfg = paiziCfg();
    $('paiziLabel').value = cfg ? cfg.label : '';
    $('paiziSeq').value = cfg ? cfg.seq.join(' ') : '';
    $('paiziSys1').value = cfg ? cfg.sys1 : ''; $('paiziStart1').value = cfg ? cfg.start1 : '';
    $('paiziSys2').value = cfg ? cfg.sys2 : ''; $('paiziStart2').value = (cfg && cfg.start2!=null) ? cfg.start2 : '';
    const sel = $('paiziAnchor'); sel.innerHTML = '<option value="">（未选）</option>';
    people.filter(p=>(p.treeId||'main')===currentTreeId).slice().sort((x,y)=>String(x.name).localeCompare(String(y.name),'zh')).forEach(p=>{
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.id===viewerId ? '（当前视角）' : ''); sel.appendChild(o); });
    const want = (cfg && cfg.anchorId) || viewerId || '';
    if(want && Array.from(sel.options).some(o=>o.value===want)) sel.value = want;
    refreshShi(cfg && cfg.anchorShi!=null ? cfg.anchorShi : '');
    ov.classList.add('show');
  }
  const close = ()=>ov.classList.remove('show');
  $('paiziOpenBtn').addEventListener('click', openPaizi);
  $('paiziRefBtn').addEventListener('click', ()=>{ window.openLinRef(); });
  $('paiziClose').addEventListener('click', close); $('paiziCancel').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  $('paiziSeq').addEventListener('input', ()=>refreshShi()); $('paiziStart1').addEventListener('input', ()=>refreshShi());
  (function(){ const sel = $('paiziPreset'); Paizi.PRESETS.forEach(p=>{ const o = document.createElement('option'); o.value = p.id; o.textContent = p.label + '（坚公 ' + p.start1 + ' 世起）'; sel.appendChild(o); });
    sel.addEventListener('change', ()=>{
      const P0 = Paizi.PRESETS.find(p=>p.id===sel.value); if(!P0) return;
      $('paiziLabel').value = P0.label; $('paiziSeq').value = P0.seq.join(' ');
      $('paiziSys1').value = P0.sys1; $('paiziStart1').value = P0.start1; $('paiziSys2').value = P0.sys2; $('paiziStart2').value = P0.start2;
      sel.value = ''; refreshShi(); toast(P0.note);
    }); })();
  $('paiziClear').addEventListener('click', ()=>{
    const t = trees.find(x=>x.id===currentTreeId); if(!t || !t.paizi){ close(); return; }
    if(!confirm('清除这棵家族树的辈分字谱设置？（不会动任何人的资料）')) return;
    pushHistory(); delete t.paizi; saveData(); renderSidePanel(); close(); toast('已清除');
  });
  $('paiziSave').addEventListener('click', ()=>{
    const seq = curSeq(); if(!seq.length){ toast('字序是空的'); return; }
    const start1 = parseInt($('paiziStart1').value,10); if(!(start1>=1)){ toast('请填第一个字是第几世'); return; }
    const sys2 = $('paiziSys2').value.trim(), s2raw = $('paiziStart2').value.trim(), start2 = s2raw==='' ? null : parseInt(s2raw,10);
    if((sys2 && start2==null) || (!sys2 && start2!=null)){ toast('第二套编号要名称和世数一起填，或者都留空'); return; }
    const anchorId = $('paiziAnchor').value, anchorShi = parseInt($('paiziAnchorShi').value,10);
    if((anchorId && !(anchorShi>=1)) || (!anchorId && anchorShi>=1)){ toast('锚点要选人，也要选他是第几世'); return; }
    const cfg = Paizi.sanitize({label:$('paiziLabel').value, seq, sys1:$('paiziSys1').value || '世', start1, sys2, start2, anchorId, anchorShi: anchorShi>=1 ? anchorShi : null});
    if(!cfg){ toast('字序里每一代必须是单个字（同一代两种写法用 | 连接）'); return; }
    const t = trees.find(x=>x.id===currentTreeId); if(!t) return;
    pushHistory(); t.paizi = cfg; saveData(); renderSidePanel(); close(); toast('辈分字谱已保存');
  });
})();

document.getElementById('moveTreeClose').addEventListener('click', ()=>document.getElementById('moveTreeOverlay').classList.remove('show'));
document.getElementById('moveTreeCancel').addEventListener('click', ()=>document.getElementById('moveTreeOverlay').classList.remove('show'));
document.getElementById('moveTreeConfirm').addEventListener('click', confirmMoveTree);
document.getElementById('moveTreeOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='moveTreeOverlay') document.getElementById('moveTreeOverlay').classList.remove('show');
});
document.getElementById('addTreeBtn').addEventListener('click', addNewTree);
document.getElementById('renameTreeBtn').addEventListener('click', renameCurrentTree);
document.getElementById('navBackBtn').addEventListener('click', navBack);
document.getElementById('navForwardBtn').addEventListener('click', navForward);
document.getElementById('exitFocusBtn').addEventListener('click', exitFocus);
document.querySelectorAll('[data-focus-adjust]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    adjustFocusGen(btn.dataset.focusAdjust, parseInt(btn.dataset.delta, 10));
  });
});
document.getElementById('hiddenBtn').addEventListener('click', ()=>{
  document.getElementById('filterSearch').value = '';
  renderHiddenPanel();
  document.getElementById('hiddenOverlay').classList.add('show');
});
document.getElementById('hiddenClose').addEventListener('click', ()=>{
  document.getElementById('hiddenOverlay').classList.remove('show');
});
document.getElementById('hiddenOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='hiddenOverlay') document.getElementById('hiddenOverlay').classList.remove('show');
});
document.getElementById('filterSearch').addEventListener('input', renderHiddenPanel);
document.getElementById('filterShowAll').addEventListener('click', ()=>setAllVisible(true));
document.getElementById('filterHideAll').addEventListener('click', ()=>setAllVisible(false));
document.getElementById('exportBtn').addEventListener('click', ()=>{
  const sel = document.getElementById('exportScopeSelect');
  sel.innerHTML = '<option value="">全部家族树（所有树打包在一起）</option>' +
    trees.map(t=>`<option value="${escapeHtml(t.id)}">仅：${escapeHtml(t.name)}</option>`).join('');
  document.getElementById('exportOverlay').classList.add('show');
});
document.getElementById('exportClose').addEventListener('click', ()=>{
  document.getElementById('exportOverlay').classList.remove('show');
});
document.getElementById('exportCancel').addEventListener('click', ()=>{
  document.getElementById('exportOverlay').classList.remove('show');
});
document.getElementById('exportEncryptToggle').addEventListener('change', (e)=>{
  document.getElementById('exportEncryptFields').style.display = e.target.checked ? '' : 'none';
});
document.getElementById('exportConfirm').addEventListener('click', ()=>{
  const scopeTreeId = document.getElementById('exportScopeSelect').value || null;
  const wantsEncrypt = document.getElementById('exportEncryptToggle').checked;
  let encryptPasscode = null;
  if(wantsEncrypt){
    const pass = document.getElementById('exportPasscodeInput').value;
    const confirmPass = document.getElementById('exportPasscodeConfirmInput').value;
    if(!pass || pass.length < 6){ toast('导出密码至少需要6位'); return; }
    if(pass !== confirmPass){ toast('两次输入的密码不一致'); return; }
    encryptPasscode = pass;
  }
  document.getElementById('exportOverlay').classList.remove('show');
  exportData(scopeTreeId, encryptPasscode);
  document.getElementById('exportPasscodeInput').value = '';
  document.getElementById('exportPasscodeConfirmInput').value = '';
  document.getElementById('exportEncryptToggle').checked = false;
  document.getElementById('exportEncryptFields').style.display = 'none';
});
document.getElementById('exportOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='exportOverlay') document.getElementById('exportOverlay').classList.remove('show');
});
document.getElementById('importBtn').addEventListener('click', ()=>document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e)=>{
  if(e.target.files[0]) importData(e.target.files[0]);
  e.target.value='';
});
window.addEventListener('resize', ()=>requestAnimationFrame(drawConnectors));

function initLockGate(){
  return new Promise(async (resolve)=>{
    const meta = await loadLockMeta();
    const screen = document.getElementById('lockScreen');
    const title = document.getElementById('lockTitle');
    const subtitle = document.getElementById('lockSubtitle');
    const confirmField = document.getElementById('lockConfirmField');
    const forgotBtn = document.getElementById('lockForgotBtn');
    const submitBtn = document.getElementById('lockSubmitBtn');
    const errorEl = document.getElementById('lockError');
    const passInput = document.getElementById('lockPasscodeInput');
    const confirmInput = document.getElementById('lockConfirmInput');
    const numpad = document.getElementById('lockNumpad');
    const keyboardToggleBtn = document.getElementById('lockKeyboardToggle');
    const hintEl = document.getElementById('lockHint');

    const isSetup = !meta;
    title.textContent = isSetup ? '设置访问密码' : '输入密码解锁';
    subtitle.textContent = isSetup
      ? '这个密码只保存在你自己的设备本地推导出的密钥里，我们不会上传、也无法帮你找回——请务必牢记。'
      : '你的家谱数据已加密保护，请输入密码解锁。';
    confirmField.style.display = isSetup ? 'block' : 'none';
    submitBtn.textContent = isSetup ? '设置密码并进入' : '解锁';
    forgotBtn.style.display = isSetup ? 'none' : 'block';

    // ---- Big-numpad passcode entry (default) with a fallback to normal
    // keyboard typing for anyone whose passcode has letters in it. The
    // inputs stay `readonly` + `inputmode=none` while in numpad mode so the
    // mobile virtual keyboard never pops up underneath the numpad; physical
    // keyboard presses are still handled manually below so desktop typing
    // keeps working even though the field is readonly. ----
    let activeLockInput = passInput;
    let numpadMode = true;

    function setNumpadMode(on){
      numpadMode = on;
      [passInput, confirmInput].forEach(inp=>{
        if(on){ inp.setAttribute('readonly','readonly'); inp.setAttribute('inputmode','none'); }
        else { inp.removeAttribute('readonly'); inp.setAttribute('inputmode','text'); }
      });
      numpad.style.display = on ? 'grid' : 'none';
      keyboardToggleBtn.textContent = on ? '⌨️' : '🔢';
      keyboardToggleBtn.title = on ? '切换为键盘输入（可包含字母）' : '切换为数字键盘';
      hintEl.textContent = on ? '密码包含字母？点击 ⌨️ 切换为键盘输入' : '点击 🔢 切换回数字键盘';
      activeLockInput.focus();
    }

    function pushDigit(d){
      if(activeLockInput.value.length>=64) return;
      activeLockInput.value += d;
      errorEl.style.display = 'none';
    }
    function popDigit(){
      activeLockInput.value = activeLockInput.value.slice(0,-1);
    }

    [passInput, confirmInput].forEach(inp=>{
      inp.addEventListener('focus', ()=>{ activeLockInput = inp; });
      // readonly inputs still fire keydown; handle digits/backspace manually
      // so a physical keyboard works too, and swallow any other key so
      // stray characters can't sneak into a readonly field.
      inp.addEventListener('keydown', (e)=>{
        if(!numpadMode || e.key==='Enter' || e.key==='Tab') return;
        e.preventDefault();
        if(e.key>='0' && e.key<='9') pushDigit(e.key);
        else if(e.key==='Backspace') popDigit();
      });
    });

    numpad.querySelectorAll('.numpad-key[data-key]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.dataset.key;
        if(key==='back') popDigit();
        else pushDigit(key);
        activeLockInput.focus();
      });
    });
    keyboardToggleBtn.addEventListener('click', ()=> setNumpadMode(!numpadMode));
    hintEl.addEventListener('click', ()=> setNumpadMode(!numpadMode));
    setNumpadMode(true);

    function showError(msg){
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    async function attempt(){
      errorEl.style.display = 'none';
      const pass = passInput.value;
      if(!pass){ showError('请输入密码'); return; }
      if(isSetup){
        if(pass.length<6){ showError('密码至少需要6位'); return; }
        if(pass !== confirmInput.value){ showError('两次输入的密码不一致'); return; }
        submitBtn.disabled = true; submitBtn.textContent = '设置中…';
        try{
          await setupPasscode(pass);
          screen.style.display = 'none';
          resolve(true);
        }catch(e){
          submitBtn.disabled = false; submitBtn.textContent = '设置密码并进入';
          showError('设置失败，请重试：' + e.message);
        }
      } else {
        submitBtn.disabled = true; submitBtn.textContent = '解锁中…';
        const ok = await tryUnlock(pass, meta);
        submitBtn.disabled = false; submitBtn.textContent = '解锁';
        if(ok){
          screen.style.display = 'none';
          resolve(false);
        } else {
          showError('密码不正确，请重试');
          passInput.value = '';
          passInput.focus();
        }
      }
    }

    submitBtn.addEventListener('click', attempt);
    passInput.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ if(isSetup) confirmInput.focus(); else attempt(); }
    });
    confirmInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') attempt(); });
    forgotBtn.addEventListener('click', async ()=>{
      if(!confirm('这会永久清除本机保存的所有家谱数据和照片（因为没有密码就没法解密），且无法恢复。确定要继续吗？')) return;
      const typed = prompt('最后确认：请输入「删除」两个字以永久清除本机数据');
      if((typed||'').trim() !== '删除'){ showError('已取消：未输入「删除」，数据没有被清除'); return; }
      try{
        if(hasClaudeStorage){
          await window.storage.delete(STORE_KEY, false);
          await window.storage.delete(LOCK_STORE_KEY, false);
        } else {
          localStorage.removeItem(STORE_KEY);
          localStorage.removeItem(LOCK_STORE_KEY);
        }
      }catch(e){}
      try{ indexedDB.deleteDatabase(PHOTO_DB_NAME); }catch(e){}
      location.reload();
    });
    passInput.focus();
  });
}

/* ============ Init ============ */
(async function init(){
  const justSetUp = await initLockGate();
  const data = await loadData();
  people = data.people;
  trees = data.trees;
  currentTreeId = data.currentTreeId;
  const countryList = document.getElementById('countryList');
  if(countryList) countryList.innerHTML = Object.keys(COUNTRY_COORDS).sort().map(c=>`<option value="${c}">`).join('');
  await loadAllPhotosIntoCache();
  await migrateLegacyPhotos();
  if(justSetUp) saveData(); // force any pre-existing legacy plaintext data to be re-saved encrypted right away
  const restoredView = applySavedViewState(readViewState());
  renderTreeSelect();
  render();
  renderSidePanel();
  if(restoredView) applyTransform(); else centerTree();
  viewStateReady = true;
  recordNavState();
  // undoStack is in-memory only and starts empty every reload, so at this
  // point "reachable" is simply "referenced by someone in people" — this
  // catches anything left orphaned by a session that ended (crash, tab
  // close) before a checkpoint elsewhere in the app could sweep it.
  gcOrphanedPhotos();
})();

// Register the service worker so the app shell can be cached for offline
// use. Registration only makes sense when served over http(s) (GitHub
// Pages, or any static host) — it's silently skipped if opened directly as
// a local file:// page, since service workers require a proper origin.
if('serviceWorker' in navigator && location.protocol!=='file:'){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./service-worker.js').catch((err)=>{
      console.warn('Service worker registration failed:', err);
    });
  });
}


/* ============ v7.9: accessibility + compact "more" menu ============ */
(function initA11yAndMoreMenu(){
  // icon-only buttons: mirror title -> aria-label
  document.querySelectorAll('button[title]:not([aria-label])').forEach(b=>b.setAttribute('aria-label', b.title));
  new MutationObserver(muts=>{
    muts.forEach(m=>m.addedNodes.forEach(n=>{
      if(n.nodeType!==1) return;
      const list = n.matches && n.matches('button[title]') ? [n] : [];
      n.querySelectorAll && n.querySelectorAll('button[title]:not([aria-label])').forEach(b=>list.push(b));
      list.forEach(b=>{ if(!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.title); });
    }));
  }).observe(document.body, {childList:true, subtree:true});

  // "⋯ more" menu and the "⇅ import/export" menu (items proxy the real,
  // possibly hidden, buttons — .click() works on display:none elements).
  function setupMenu(btnId, menuId){
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if(!btn || !menu) return;
    const close = ()=>{ menu.classList.remove('show'); btn.setAttribute('aria-expanded','false'); };
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const open = !menu.classList.contains('show');
      document.querySelectorAll('.more-menu.show').forEach(m=>{ if(m!==menu) m.classList.remove('show'); });
      menu.classList.toggle('show', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    menu.querySelectorAll('[data-proxy]').forEach(item=>{
      item.addEventListener('click', ()=>{
        close();
        const target = document.getElementById(item.dataset.proxy);
        if(target) target.click();
      });
    });
    document.addEventListener('click', (e)=>{ if(!menu.contains(e.target) && e.target!==btn) close(); });
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });
  }
  setupMenu('moreBtn','moreMenu');
  setupMenu('ioBtn','ioMenu');
})();


/* ============ v8.3: compact (icon-style) view toggle ============ */
function setCompactView(on){
  compactView = !!on;
  try{ localStorage.setItem('ft_compact_view', compactView ? '1' : '0'); }catch(e){}
  document.body.classList.toggle('compact-view', compactView);
  const b = document.getElementById('compactBtn');
  if(b){ b.classList.toggle('active', compactView); b.setAttribute('aria-pressed', String(compactView)); }
  render();
  if(focusPersonId) centerOnPerson(focusPersonId, true); else centerTree();
}
(function initCompactBtn(){
  const b = document.getElementById('compactBtn');
  if(!b) return;
  b.classList.toggle('active', compactView);
  b.setAttribute('aria-pressed', String(compactView));
  b.addEventListener('click', ()=>setCompactView(!compactView));
})();


/* ============ v8.4: quick bars + floating controls ============ */
document.querySelectorAll('#quickUp [data-up]').forEach(b=>{
  b.addEventListener('click', ()=>{
    if(!focusPersonId) return;
    focusUpGen = parseInt(b.dataset.up, 10);
    render();
    centerOnPerson(focusPersonId, true);
    recordNavState();
  });
});
document.querySelectorAll('#quickDown [data-down]').forEach(b=>{
  b.addEventListener('click', ()=>{
    if(!focusPersonId) return;
    focusDownGen = parseInt(b.dataset.down, 10);
    focusDownSpouses = b.dataset.sp === '1';
    render();
    centerOnPerson(focusPersonId, true);
    recordNavState();
  });
});

// locate: bring the focused / selected person (or the whole tree) back to the centre
document.getElementById('fabLocate').addEventListener('click', ()=>{
  const id = focusPersonId || selectedId;
  if(id && personById(id)) centerOnPerson(id); else centerTree();
});

// search button (narrow screens: the top-bar search box is tucked away until needed)
(function initFabSearch(){
  const btn = document.getElementById('fabSearch');
  const input = document.getElementById('searchInput');
  if(!btn || !input) return;
  btn.addEventListener('click', ()=>{
    document.body.classList.add('search-open');
    input.focus();
  });
  input.addEventListener('blur', ()=>{
    setTimeout(()=>document.body.classList.remove('search-open'), 250);
  });
})();

// export the whole tree as a PNG (html2canvas is bundled locally, loaded on first use)
let html2canvasLoading = null;
function loadHtml2Canvas(){
  if(window.html2canvas) return Promise.resolve();
  if(html2canvasLoading) return html2canvasLoading;
  html2canvasLoading = new Promise((resolve, reject)=>{
    const sc = document.createElement('script');
    sc.src = './html2canvas.min.js';
    sc.onload = resolve;
    sc.onerror = ()=>{ html2canvasLoading = null; reject(new Error('load failed')); };
    document.head.appendChild(sc);
  });
  return html2canvasLoading;
}
document.getElementById('fabShot').addEventListener('click', async ()=>{
  const canvasEl = document.getElementById('canvas');
  if(!canvasEl || !canvasEl.querySelector('.card')){ toast('画布上还没有成员可导出'); return; }
  toast('正在生成图片…');
  const prevTransform = canvasEl.style.transform;
  try{
    await loadHtml2Canvas();
    document.body.classList.add('exporting');
    canvasEl.style.transform = 'none';
    await new Promise(r=>setTimeout(r, 60));
    const out = await window.html2canvas(canvasEl, {
      backgroundColor: '#F6F1E4',
      scale: Math.min(2, window.devicePixelRatio || 1),
      useCORS: true, logging: false
    });
    const blob = await new Promise(res=>out.toBlob(res, 'image/png'));
    if(!blob) throw new Error('empty');
    const t = trees.find(x=>x.id===currentTreeId);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(t && t.name) || '家谱'}-${new Date().toISOString().slice(0,10)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
    toast('图片已保存');
  }catch(err){
    console.error(err);
    toast('生成图片失败，请重试');
  }finally{
    canvasEl.style.transform = prevTransform;
    document.body.classList.remove('exporting');
  }
});
