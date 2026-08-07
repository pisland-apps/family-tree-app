/* ============ App version (shown in the small badge, bottom-right) ============
   Bump this on every deploy alongside CACHE_VERSION in service-worker.js —
   they're independent strings in separate files, nothing keeps them in sync
   automatically. This one is just for you to visually confirm you're on the
   latest build; it has no effect on caching. */
const APP_VERSION = 'v6';
const APP_VERSION_DATE = '2026-08-08';
(function initVersionBadge(){
  const el = document.getElementById('versionBadge');
  if(el) el.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;
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
let focusPersonId = null; // when set, only this person's family (within the gen limits below) shows
let focusUpGen = 2;       // how many generations of ancestors to include
let focusDownGen = 2;     // how many generations of descendants to include
let currentFocusSet = null; // recomputed each render() from the above

function uid(){ return 'p_' + Math.random().toString(36).slice(2,10); }

function personById(id){ return people.find(p=>p.id===id); }
function childrenOf(id){
  return people.filter(p => p.parents && p.parents.includes(id));
}
function initials(name){
  if(!name) return '?';
  const parts = name.trim().split(/\s+/);
  if(parts.length===1) return parts[0].slice(0,1);
  return parts[0].slice(0,1)+parts[parts.length-1].slice(0,1);
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
  [focusPersonId, ...descendantIds].forEach(id=>{
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
  pushHistory();
  const p = personById(id);
  if(!p) return;
  p.collapsed = !p.collapsed;
  saveData();
  render();
  renderSidePanel();
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
    withAnchor.sort((a,b)=>{
      const ah = a.c.orderHints && a.c.orderHints[currentTreeId];
      const bh = b.c.orderHints && b.c.orderHints[currentTreeId];
      const av = ah!==undefined ? ah : a.anchor*10;
      const bv = bh!==undefined ? bh : b.anchor*10;
      return av-bv;
    });

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

function render(){
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
    genLabel.textContent = `第 ${li+1} 代`;
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
        const cardEl = el.querySelector('.card[data-id="'+m.id+'"]');
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
  card.className = 'card ' + genderClass + (p.id===selectedId ? ' selected':'') + (bridge ? ' bridge-card':'');
  card.dataset.id = p.id;
  const avatarInner = photoSrc(p) ? `<img src="${escapeHtml(photoSrc(p))}" alt="">` : initials(p.name);
  const kidCount = childrenOf(p.id).length;
  const collapseBtn = kidCount>0 ? `
    <button class="collapse-toggle ${p.collapsed?'is-collapsed':''}" title="${p.collapsed ? '展开下一代' : '收起下一代'}" data-collapse="${escapeHtml(p.id)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${p.collapsed ? '<path d="M12 5v14M5 12h14"/>' : '<path d="M5 12h14"/>'}</svg>
      ${p.collapsed ? `<span class="collapse-count">${kidCount}</span>` : ''}
    </button>` : '';
  const bridgeBadge = bridge ? `<div class="bridge-badge" data-goto-tree="${escapeHtml(p.id)}" title="属于另一棵家族树，点击前往查看">🔗 ${escapeHtml((trees.find(t=>t.id===(p.treeId||'main'))||{}).name||'其他家族')}</div>` : '';
  card.innerHTML = `
    ${collapseBtn}
    <div class="avatar">${avatarInner}</div>
    <div class="cname">${escapeHtml(p.name)}</div>
    <div class="cyears">${yearsLabel(p)}</div>
    ${bridgeBadge}
    ${p.notes ? `<div class="card-tooltip">${escapeHtml(p.notes)}</div>` : ''}
  `;
  card.addEventListener('click', ()=>selectPerson(p.id));
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
  const nameEl = card.querySelector('.cname');
  if(nameEl){
    nameEl.title = '点击姓名聚焦查看此人的家庭';
    nameEl.addEventListener('click', (e)=>{
      e.stopPropagation();
      enterFocus(p.id);
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
    const el = canvas.querySelector('.card[data-id="'+id+'"]');
    if(!el) return null;
    const r = el.getBoundingClientRect();
    // r is already scaled by the canvas's own CSS transform (scale(zoom)).
    // This svg lives inside that same transformed canvas, so it will be
    // scaled by zoom too — dividing by zoom here undoes the one already
    // baked into getBoundingClientRect, so the net scaling applied ends up
    // happening exactly once (matching the cards) instead of twice.
    return {
      cx: (r.left - canvasRect.left + r.width/2) / zoom,
      top: (r.top - canvasRect.top) / zoom,
      bottom: (r.bottom - canvasRect.top) / zoom,
      width: r.width / zoom
    };
  }

  // marriage lines
  const drawnPairs = new Set();
  visiblePeople().forEach(p=>{
    (p.spouses||[]).filter(isVisible).forEach(sid=>{
      const key = [p.id,sid].sort().join('|');
      if(drawnPairs.has(key)) return;
      drawnPairs.add(key);
      const elA = canvas.querySelector('.card[data-id="'+p.id+'"]');
      const elB = canvas.querySelector('.card[data-id="'+sid+'"]');
      if(elA && elB && elA.parentElement===elB.parentElement && elA.parentElement.classList.contains('couple-card')){
        return; // already visually joined into one merged card, no need for a duplicate line
      }
      const a = cardRect(p.id), b = cardRect(sid);
      if(!a||!b) return;
      const y = (a.top+a.bottom)/2;
      const path = document.createElementNS(svgNS,'path');
      path.setAttribute('d', `M ${a.cx+a.width/2-4} ${y} L ${b.cx-b.width/2+4} ${y}`);
      path.setAttribute('stroke', 'var(--accent-2)');
      path.setAttribute('stroke-width','2.5');
      path.setAttribute('fill','none');
      svg.appendChild(path);
    });
  });

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
    const endY = childRect.top;
    const childLevel = lastColumnIndex[child.id] ? lastColumnIndex[child.id].level : -1;

    clusters.forEach(cluster=>{
      const anchorIds = cluster.map(c=>c.pid);
      const rects = anchorIds.map(cardRect).filter(Boolean);
      if(rects.length===0) return;
      const startX = rects.reduce((s,r)=>s+r.cx,0)/rects.length;
      const startY = Math.max(...rects.map(r=>r.bottom));
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
    families.forEach((fam, idx)=>{
      const fraction = n<=1 ? 0.5 : 0.28 + (idx/(n-1))*0.5;
      let hash = 0;
      for(let i=0;i<fam.key.length;i++){ hash = (hash*31 + fam.key.charCodeAt(i)) | 0; }
      const lineColor = lineColors[Math.abs(hash) % lineColors.length];
      fam.jobs.forEach(job=>{
        const midY = job.startY + (job.endY-job.startY)*fraction;
        const path = document.createElementNS(svgNS,'path');
        path.setAttribute('d', `M ${job.startX} ${job.startY} L ${job.startX} ${midY} L ${job.endX} ${midY} L ${job.endX} ${job.endY}`);
        path.setAttribute('stroke', lineColor);
        path.setAttribute('stroke-width','2');
        path.setAttribute('fill','none');
        path.setAttribute('opacity','0.8');
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
  focusPersonId = id;
  render();
  renderSidePanel();
  centerTree();
  toast(`已聚焦「${p.name}」的家庭`);
  recordNavState();
}
function centerOnPerson(id){
  requestAnimationFrame(()=>{
    const wrap = document.getElementById('canvasWrap');
    const el = document.querySelector('.card[data-id="'+id+'"]');
    if(!wrap || !el){ centerTree(); return; }
    const wrapRect = wrap.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elCenterX = elRect.left + elRect.width/2;
    const elCenterY = elRect.top + elRect.height/2;
    const wrapCenterX = wrapRect.left + wrapRect.width/2;
    const wrapCenterY = wrapRect.top + wrapRect.height/2;
    // pan is a plain screen-pixel offset (applied outside the canvas's own
    // scale), so a plain screen-pixel delta can be added directly here.
    pan.x += (wrapCenterX - elCenterX);
    pan.y += (wrapCenterY - elCenterY);
    applyTransform();
  });
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
  centerTree();
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
let navHistory = [];
let navIndex = -1;
let navigatingHistory = false; // guard so restoring a state doesn't re-record itself
function recordNavState(){
  if(navigatingHistory) return;
  const state = { selectedId, currentTreeId, focusPersonId, focusUpGen, focusDownGen, focusSidewaysLevels: Array.from(focusSidewaysLevels) };
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
        centerTree();
      });
    });
  }
}
let mapHubCountry = null; // user-chosen country to draw root-style connector lines from
let worldMapSVGText = null; // cached after first successful load
let worldMapLoadAttempted = false;
async function loadWorldMapSVG(){
  if(worldMapSVGText || worldMapLoadAttempted) return worldMapSVGText;
  worldMapLoadAttempted = true;
  const sources = [
    'https://cdn.jsdelivr.net/gh/flekschas/simple-world-map@master/world-map.min.svg',
    'https://cdn.statically.io/gh/flekschas/simple-world-map/master/world-map.min.svg',
  ];
  for(const url of sources){
    try{
      const res = await fetch(url);
      if(res.ok){
        const text = await res.text();
        if(text.includes('<svg') && text.includes('<path')){
          worldMapSVGText = text;
          return worldMapSVGText;
        }
      }
    }catch(e){ /* try next source */ }
  }
  return null;
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
    if(!groups[match.name]) groups[match.name] = {lat:match.lat, lng:match.lng, iso:match.iso, people:[]};
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
    getPinPos = (g)=>{
      const fallback = {x: minX+(g.lng+180)/360*W, y: minY+(90-g.lat)/180*H};
      if(g.iso){
        const matches = svg.querySelectorAll('#'+g.iso);
        let el = null;
        matches.forEach(m=>{ if(m.classList && m.classList.contains('mainland')) el = m; });
        if(!el && matches.length) el = matches[0];
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

    const label = document.createElementNS(svgNS,'text');
    label.setAttribute('x', pos.x);
    label.setAttribute('y', pos.y-11);
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
  const old = wrap.querySelector('.map-popover');
  if(old) old.remove();
  const pop = document.createElement('div');
  pop.className = 'map-popover';
  pop.style.left = `min(${pos.x}%, 78%)`;
  pop.style.top = `min(${pos.y}%, 75%)`;
  pop.innerHTML = `
    <div class="mp-title">${escapeHtml(countryName)} · ${group.people.length}位</div>
    ${group.people.map(p=>{
      const avatarInner = photoSrc(p) ? `<img src="${escapeHtml(photoSrc(p))}">` : initials(p.name);
      return `<div class="mp-person" data-goto-map="${escapeHtml(p.id)}"><div class="mp-avatar">${avatarInner}</div>${escapeHtml(p.name)}</div>`;
    }).join('')}
  `;
  wrap.appendChild(pop);
  pop.querySelectorAll('[data-goto-map]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.gotoMap;
      const person = personById(id);
      if(person){
        currentTreeId = person.treeId || 'main';
        renderTreeSelect();
        selectPerson(id);
      }
      document.getElementById('mapOverlay').classList.remove('show');
    });
  });
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
  render();
  renderSidePanel();
  recordNavState();
}

function renderSidePanel(){
  const panel = document.getElementById('sidePanel');
  if(!selectedId){ panel.classList.add('hidden'); return; }
  const p = personById(selectedId);
  if(!p){ panel.classList.add('hidden'); selectedId=null; return; }
  panel.classList.remove('hidden');

  const parents = (p.parents||[]).map(personById).filter(Boolean);
  const spouses = (p.spouses||[]).map(personById).filter(Boolean);
  const kids = childrenOf(p.id);

  function chip(person, label){
    const avatarInner = person.photo ? `<img src="${escapeHtml(person.photo)}">` : initials(person.name);
    const hiddenTag = person.hidden ? '<span style="color:var(--danger);">（已隐藏）</span>' : '';
    return `<div class="rel-chip" data-goto="${escapeHtml(person.id)}">
      <div class="mini-avatar">${avatarInner}</div>
      <div>${escapeHtml(person.name)}${label?('<span style="color:var(--ink-soft)"> · '+label+'</span>'):''}${hiddenTag}</div>
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
    ${isBridgePerson(p.id) ? `<div class="bridge-notice" data-goto-tree-panel="${escapeHtml(p.id)}">🔗 属于「${escapeHtml((trees.find(t=>t.id===(p.treeId||'main'))||{}).name||'其他家族')}」— 点击前往查看</div>` : ''}
    ${p.notes ? `<div class="detail-notes">${escapeHtml(p.notes)}</div>` : ''}

    <div class="detail-section-title">父母</div>
    <div class="rel-list">${parents.length? parents.map(x=>chip(x)).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="detail-section-title">配偶</div>
    <div class="rel-list">${spouses.length? spouses.map(x=>chip(x)).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="detail-section-title">子女</div>
    <div class="rel-list">${kids.length? kids.map(x=>chip(x)).join('') : '<div class="hint">未记录</div>'}</div>

    <div class="quick-actions">
      <button class="btn btn-ghost" data-action="add-parent">+ 父母</button>
      <button class="btn btn-ghost" data-action="add-spouse">+ 配偶</button>
      <button class="btn btn-ghost" data-action="add-child">+ 子女</button>
      ${kids.length>0 ? `<button class="btn btn-ghost" data-action="toggle-collapse">${p.collapsed?'展开下一代':'收起下一代'}</button>` : ''}
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
  document.getElementById('fNotes').value = '';
  document.getElementById('photoPreview').innerHTML = '👤';
  document.querySelectorAll('input[name=gender]').forEach(r=>r.checked = r.value==='M');

  populateMultiSelect('parentsSelect', people, [], 4);
  populateMultiSelect('spousesSelect', people, [], 99);

  if(id){
    const p = personById(id);
    document.getElementById('fName').value = p.name || '';
    document.getElementById('fBirth').value = p.birth || '';
    document.getElementById('fDeath').value = p.death || '';
    document.getElementById('fCountry').value = p.country || '';
    document.getElementById('fNotes').value = p.notes || '';
    modalPhotoId = p.photoId || null;
    if(photoSrc(p)) document.getElementById('photoPreview').innerHTML = `<img src="${escapeHtml(photoSrc(p))}">`;
    document.querySelectorAll('input[name=gender]').forEach(r=>r.checked = r.value===p.gender);
    populateMultiSelect('parentsSelect', people.filter(x=>x.id!==id), p.parents||[], 4);
    populateMultiSelect('spousesSelect', people.filter(x=>x.id!==id), p.spouses||[], 99);
  } else if(modalPreset.presetParent){
    populateMultiSelect('parentsSelect', people, [modalPreset.presetParent], 4);
  }

  overlay.classList.add('show');
  document.getElementById('fName').focus();
}

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
  toast('已新建 ' + name);
  return newPerson.id;
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
  editingId = null;
  modalPreset = {};
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
  const parentIds = Array.from(document.querySelectorAll('#parentsSelect input:checked')).map(i=>i.value);
  const spouseIds = Array.from(document.querySelectorAll('#spousesSelect input:checked')).map(i=>i.value);

  if(editingId){
    const p = personById(editingId);
    // clean old spouse links then relink
    people.forEach(x=>{ if(x.spouses) x.spouses = x.spouses.filter(id=>id!==editingId); });
    p.name=name; p.gender=gender; p.birth=birth; p.death=death; p.country=country; p.notes=notes;
    p.photoId = modalPhotoId;
    p.parents = parentIds;
    p.spouses = spouseIds;
    spouseIds.forEach(sid=>{
      const sp = personById(sid);
      if(sp){ sp.spouses = sp.spouses||[]; if(!sp.spouses.includes(editingId)) sp.spouses.push(editingId); }
    });
    saveData(); render(); renderSidePanel();
    toast('已更新 ' + name);
  } else {
    const newId = uid();
    const newPerson = { id:newId, name, gender, birth, death, country, notes, photoId: modalPhotoId, parents: parentIds, spouses: spouseIds, treeId: currentTreeId };
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
}

/* ============ Search ============ */
function handleSearch(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const box = document.getElementById('searchResults');
  if(!q){ box.classList.remove('show'); box.innerHTML=''; return; }
  const matches = people.filter(p=>p.name.toLowerCase().includes(q)).slice(0,8);
  if(matches.length===0){ box.innerHTML = '<div class="search-item" style="color:var(--ink-soft)">未找到匹配成员</div>'; box.classList.add('show'); return; }
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
function applyTransform(){
  document.getElementById('canvas').style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  document.getElementById('zoomReset').textContent = Math.round(zoom*100)+'%';
}
document.getElementById('zoomIn').addEventListener('click', ()=>{ zoom=Math.min(2, zoom+0.1); applyTransform(); });
document.getElementById('zoomOut').addEventListener('click', ()=>{ zoom=Math.max(0.3, zoom-0.1); applyTransform(); });
document.getElementById('zoomReset').addEventListener('click', ()=>{ zoom=1; applyTransform(); centerTree(); });

const wrap = document.getElementById('canvasWrap');
wrap.addEventListener('mousedown', (e)=>{
  if(e.target.closest('.card')) return;
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
  if(e.target.closest('.card')) return;
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

async function applyImportedData(data){
  if(Array.isArray(data)){
    // legacy format: a plain people array, single tree
    people = data;
    trees = DEFAULT_TREES.slice();
    currentTreeId = 'main';
  } else if(data && Array.isArray(data.people)){
    people = data.people;
    trees = (data.trees && data.trees.length) ? data.trees : DEFAULT_TREES.slice();
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
  if(photosFolder){
    photosFolder.forEach((relPath, fileEntry)=>{
      photoJobs.push((async ()=>{
        const blob = await fileEntry.async('blob');
        const photoId = relPath.replace(/\.[a-zA-Z0-9]+$/, '');
        await putPhotoBlob(photoId, blob);
        photoCache[photoId] = URL.createObjectURL(blob);
      })());
    });
  }
  await Promise.all(photoJobs);
  await applyImportedData(data);
}

function importData(file){
  pushHistory();
  const lowerName = file.name.toLowerCase();
  if(lowerName.endsWith('.ftenc')){
    const passcode = prompt('这是一个加密导出文件，请输入导出时设置的密码：');
    if(!passcode){ toast('已取消导入'); return; }
    file.arrayBuffer().then(async (buf)=>{
      const envelopeBytes = new Uint8Array(buf);
      const zipBytes = await decryptExportBytes(passcode, envelopeBytes);
      await importZipBytes(zipBytes);
    }).catch(err=>{
      toast('导入失败：' + (err.message || '密码错误或文件已损坏'));
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
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('saveBtn').addEventListener('click', saveModal);
document.getElementById('modalOverlay').addEventListener('click', (e)=>{ if(e.target.id==='modalOverlay') closeModal(); });
document.getElementById('searchInput').addEventListener('input', handleSearch);
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
    modalPhotoId = photoId;
    document.getElementById('photoPreview').innerHTML = `<img src="${objectUrl}">`;
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
  if(!newPass || newPass.length<4){ errEl.textContent='新密码至少需要4位'; errEl.style.display='block'; return; }
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
    if(!pass || pass.length < 4){ toast('导出密码至少需要4位'); return; }
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

    const isSetup = !meta;
    title.textContent = isSetup ? '设置访问密码' : '输入密码解锁';
    subtitle.textContent = isSetup
      ? '这个密码只保存在你自己的设备本地推导出的密钥里，我们不会上传、也无法帮你找回——请务必牢记。'
      : '你的家谱数据已加密保护，请输入密码解锁。';
    confirmField.style.display = isSetup ? 'block' : 'none';
    submitBtn.textContent = isSetup ? '设置密码并进入' : '解锁';
    forgotBtn.style.display = isSetup ? 'none' : 'block';

    function showError(msg){
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    async function attempt(){
      errorEl.style.display = 'none';
      const pass = passInput.value;
      if(!pass || pass.length<4){ showError('密码至少需要4位'); return; }
      if(isSetup){
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
  renderTreeSelect();
  render();
  renderSidePanel();
  centerTree();
  recordNavState();
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
