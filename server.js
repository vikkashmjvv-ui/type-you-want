// =====================================================================
//  TYPE YOU WANT: the complete app in ONE file (website + server).
//  Setup (once):   npm init -y   then   npm install ws
//  Run:            node server.js        -> open http://localhost:3000
// =====================================================================
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;

// ---------- accounts: username + password (stored as salted scrypt hashes) ----------
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'tyw-users.json');
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.log('Could not save data:', e.message); } };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const makeUser = (name, pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { name, salt, hash: hashPw(pw, salt), best: 0, tests: 0, history: [], progress: {}, created: Date.now() }; };
const checkPw = (u, pw) => { const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pub = u => ({ name: u.name, best: u.best, tests: u.tests, history: u.history, progress: u.progress, library: u.library || [], created: u.created });
const userByToken = t => { const u = db.users[db.sessions[t]]; return u && u.hash ? u : null; };
const tokenOf = req => (req.headers.authorization || '').replace('Bearer ', '');
const newSession = key => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = key; return t; };
const fails = {};
const locked = k => fails[k] && Date.now() < fails[k].until;
const failed = k => { const f = fails[k] || (fails[k] = { n: 0, until: 0 }); if (++f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } };
const RESERVED = ['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring'];

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 1e5) => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > max) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

// ---------- live book library (Project Gutenberg) ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const getJ = async (u, ms = 20000, tries = 2) => {
  const host = new URL(u).hostname;
  for (let i = 1; ; i++) {
    let r;
    try { r = await fetch(u, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(ms), redirect: 'follow' }); }
    catch (e) { throw new Error(host + ': ' + ((e.cause && (e.cause.code || e.cause.message)) || e.message)); }
    if (r.ok) return r;
    if (i >= tries || ![429, 500, 502, 503, 504].includes(r.status)) throw new Error(host + ' replied ' + r.status);
    await new Promise(x => setTimeout(x, 1500));
  }
};
// Built-in catalog: always shows instantly, even if the live search service is down.
const CATALOG = [[1342,'Pride and Prejudice','Jane Austen'],[11,"Alice's Adventures in Wonderland",'Lewis Carroll'],[84,'Frankenstein','Mary Shelley'],[2701,'Moby Dick','Herman Melville'],
[1661,'The Adventures of Sherlock Holmes','Arthur Conan Doyle'],[345,'Dracula','Bram Stoker'],[98,'A Tale of Two Cities','Charles Dickens'],[1400,'Great Expectations','Charles Dickens'],
[46,'A Christmas Carol','Charles Dickens'],[74,'The Adventures of Tom Sawyer','Mark Twain'],[76,'Adventures of Huckleberry Finn','Mark Twain'],[1260,'Jane Eyre','Charlotte Bronte'],
[768,'Wuthering Heights','Emily Bronte'],[174,'The Picture of Dorian Gray','Oscar Wilde'],[2554,'Crime and Punishment','Fyodor Dostoevsky'],[2600,'War and Peace','Leo Tolstoy'],
[215,'The Call of the Wild','Jack London'],[910,'White Fang','Jack London'],[35,'The Time Machine','H. G. Wells'],[36,'The War of the Worlds','H. G. Wells'],
[164,'Twenty Thousand Leagues Under the Sea','Jules Verne'],[103,'Around the World in Eighty Days','Jules Verne'],[120,'Treasure Island','Robert Louis Stevenson'],
[43,'Strange Case of Dr Jekyll and Mr Hyde','Robert Louis Stevenson'],[1952,'The Yellow Wallpaper','Charlotte Perkins Gilman'],[514,'Little Women','Louisa May Alcott'],
[16,'Peter Pan','J. M. Barrie'],[55,'The Wonderful Wizard of Oz','L. Frank Baum'],[829,"Gulliver's Travels",'Jonathan Swift'],[244,'A Study in Scarlet','Arthur Conan Doyle'],
[2852,'The Hound of the Baskervilles','Arthur Conan Doyle'],[205,'Walden','Henry David Thoreau'],[1727,'The Odyssey','Homer'],[158,'Emma','Jane Austen'],[161,'Sense and Sensibility','Jane Austen'],
[1184,'The Count of Monte Cristo','Alexandre Dumas'],[135,'Les Miserables','Victor Hugo'],[5200,'Metamorphosis','Franz Kafka'],[996,'Don Quixote','Miguel de Cervantes'],
[64317,'The Great Gatsby','F. Scott Fitzgerald'],[2680,'Meditations','Marcus Aurelius'],[219,'Heart of Darkness','Joseph Conrad'],[2500,'Siddhartha','Hermann Hesse'],
[25344,'The Scarlet Letter','Nathaniel Hawthorne'],[1399,'Anna Karenina','Leo Tolstoy'],[521,'Robinson Crusoe','Daniel Defoe'],[3825,'Pygmalion','George Bernard Shaw']];
const coverOf = id => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
const books = {};
function clean(raw, custom) {
  let t = raw.replace(/\r/g, '');
  const s = t.search(/\*\*\* ?START OF[^\n]*\n/); if (s >= 0) t = t.slice(t.indexOf('\n', s) + 1);
  const e = t.search(/\*\*\* ?END OF/); if (e >= 0) t = t.slice(0, e);
  const re = /\n\s*(CHAPTER|Chapter|BOOK|Book|PART|Part|VOLUME|Volume|LETTER|Letter)\s+[IVXLC\d]+/g;
  const idx = []; let m; while ((m = re.exec(t))) idx.push(m.index);
  let start = 0; if (!custom) for (let i = 0; i < idx.length; i++) { if (i === idx.length - 1 || idx[i + 1] - idx[i] > 1500) { start = idx[i]; break; } }
  t = t.slice(start);
  return t.replace(/_/g, '').replace(/\s*--\s*/g, ' - ')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
function paginate(t, n = 450) {
  const out = []; let i = 0;
  while (i < t.length) { let j = Math.min(i + n, t.length);
    if (j < t.length) { const k = t.lastIndexOf(' ', j); if (k > i + n * 0.6) j = k; }
    out.push(t.slice(i, j).trim()); i = j; }
  return out.filter(Boolean);
}
const CACHE = path.join(process.env.DATA_DIR || __dirname, 'book-cache'); try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}
async function loadBook(id) {
  if (books[id]) return books[id];
  const cf = path.join(CACHE, id + '.json');
  try { return (books[id] = JSON.parse(fs.readFileSync(cf, 'utf8'))); } catch {}   // downloaded or uploaded before -> instant
  if (!/^\d+$/.test(id)) throw new Error('Book not found.');
  let raw = null; const errs = [];
  try { raw = fs.readFileSync(path.join(CACHE, id + '.txt'), 'utf8'); } catch {}   // you can also save a book yourself as book-cache/<id>.txt
  let meta = null;
  if (!raw) {
    const dir = id.length > 1 ? id.slice(0, -1).split('').join('/') : '0';
    const mirrors = ['https://aleph.gutenberg.org', 'http://aleph.gutenberg.org', 'https://gutenberg.pglaf.org', 'http://gutenberg.pglaf.org']
      .flatMap(m => [`${id}-0.txt`, `${id}.txt`].map(n => `${m}/${dir}/${id}/${n}`));
    const urls = [...mirrors, `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, `https://www.gutenberg.org/files/${id}/${id}-0.txt`, `https://www.gutenberg.org/ebooks/${id}.txt.utf-8`];
    const attempt = async u => { const t = await (await getJ(u, 15000, 2)).text(); if (t.length < 2000) throw new Error('empty file'); return t; };
    try { raw = await Promise.any(urls.map(attempt)); }          // all sources at the same time, first good one wins
    catch (e) { (e.errors || []).forEach(x => errs.push(x.message)); }
  }
  if (!raw) throw new Error('Could not download this book (' + [...new Set(errs)].slice(0, 3).join('; ') + '). Try again in a minute, or try another book.');
  try { meta = await (await getJ('https://gutendex.com/books/' + id + '/', 6000, 1)).json(); } catch {}
  let title = meta && meta.title, author = meta && (meta.authors[0] || {}).name;
  const known = CATALOG.find(c => String(c[0]) === id);
  if (!title) { const m = raw.match(/Title:\s*(.+)/); title = m ? m[1].trim() : known ? known[1] : 'Book ' + id; }
  if (!author) { const m = raw.match(/Author:\s*(.+)/); author = m ? m[1].trim() : known ? known[2] : 'Unknown'; }
  const pages = paginate(clean(raw));
  if (pages.length < 3) throw new Error('This book could not be read as plain text. Try another one.');
  const b = { id, title, author, pages }; try { fs.writeFileSync(cf, JSON.stringify(b)); } catch {}
  return (books[id] = b);
}

// ---------- the website itself ----------
const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Type You Want</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#08090b;--ink:#e9eef2;--mute:#8d99a5;--card:#13171c;--line:#252c34;--teal:#2bb3a5;--teal-d:#1a8a7e;--amber:#f5b83d;--red:#ef6a6a;--green:#46c27c;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--ink);font-family:Sora,system-ui,sans-serif;min-height:100vh}
header{display:none;align-items:center;justify-content:space-between;padding:14px 28px;border-bottom:1px solid var(--line);gap:12px}
header.on{display:flex}
.logo{display:flex;gap:10px;align-items:center;font-weight:800;font-size:20px;cursor:pointer}
.key{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:8px;background:var(--teal);color:#fff;border-bottom:4px solid var(--teal-d);font-family:'JetBrains Mono',monospace}
.me{display:flex;gap:16px;align-items:center;color:var(--mute);font-size:14px}.me b{color:var(--ink)}
.me button{background:none;border:1px solid var(--line);color:var(--mute);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}
header{background:#0d0f12}
main{max-width:980px;margin:0 auto;padding:32px 20px 60px}
.view{display:none}.view.on{display:block}
h1{font-size:clamp(30px,5vw,48px);line-height:1.1;margin:8px 0 10px;font-weight:800;letter-spacing:-.02em}
h2{font-size:24px;margin:0 0 6px}h3{margin:28px 0 12px;font-size:17px}
p.sub{color:var(--mute);margin:0 0 28px;max-width:560px;line-height:1.6}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:16px}
.mode{background:var(--card);border:1px solid var(--line);border-bottom:5px solid var(--line);border-radius:14px;padding:22px;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:transform .12s,border-color .12s}
.mode:hover{transform:translateY(-3px);border-bottom-color:var(--teal)}.mode:active{transform:translateY(1px)}
.mode b{display:block;font-size:18px;margin:10px 0 6px}.mode span{color:var(--mute);font-size:14px;line-height:1.5}.ico{font-size:28px}
.btn{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 22px;background:var(--teal);color:#fff;border-bottom:4px solid var(--teal-d);cursor:pointer}
.btn:active{transform:translateY(2px);border-bottom-width:2px}
.btn.alt{background:var(--card);color:var(--ink);border:1px solid var(--line);border-bottom:4px solid var(--line)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.back{background:none;border:0;color:var(--mute);font:inherit;cursor:pointer;padding:0;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:20px}
.chip{font:inherit;padding:9px 16px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
input[type=text],input[type=email],textarea.own{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);width:100%}
input:focus,textarea:focus{outline:2px solid var(--teal);outline-offset:1px}
textarea.own{min-height:130px;font-family:'JetBrains Mono',monospace;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px;max-width:440px;margin:40px auto}
.card label{display:block;font-size:14px;color:var(--mute);margin:16px 0 6px}
.card .btn{width:100%;margin-top:22px}
.err{color:var(--red);min-height:22px;margin-top:12px;font-size:14px}.note{color:var(--mute);font-size:13px;line-height:1.5;margin-top:10px}
.tabs{display:flex;gap:6px;margin:16px 0 4px;background:var(--bg);padding:4px;border-radius:12px}.tabs button{flex:1;font:inherit;font-weight:600;border:0;border-radius:9px;padding:10px;background:none;color:var(--mute);cursor:pointer}.tabs button.on{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:0 0 8px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.kpi small{color:var(--mute);display:block;margin-bottom:4px}.kpi b{font-size:26px}
.hist{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}.hist div{display:flex;justify-content:space-between;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);font-size:14px;color:var(--mute)}.hist div:last-child{border:0}.hist span:first-child{flex:1;color:var(--ink)}
.card input[type=checkbox]{width:auto}
.stats{display:flex;gap:28px;margin-bottom:16px;flex-wrap:wrap}
.stat small{display:block;color:var(--mute);font-size:13px}.stat b{font-size:30px;font-variant-numeric:tabular-nums}
.bar{height:8px;background:var(--line);border-radius:9px;overflow:hidden;margin-bottom:18px}.bar i{display:block;height:100%;width:0;background:var(--teal);transition:width .15s}
.ptitle{color:var(--mute);font-size:14px;margin-bottom:10px;min-height:20px}
.paper{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 28px;font-family:'JetBrains Mono',monospace;font-size:22px;line-height:2;max-height:270px;overflow:hidden;cursor:text;position:relative;text-align:left}
.paper .w{display:inline-block;white-space:pre}
.paper span{border-radius:3px}.ok{color:var(--green)}.bad{color:var(--red);background:color-mix(in srgb,var(--red) 18%,transparent)}
.paper .w>span:not(.ok):not(.bad){color:var(--mute)}
.cur{display:inline-block;width:0;height:1.2em;vertical-align:text-bottom;border-left:2px solid var(--amber);margin-left:-1px;animation:blink 1s steps(1) infinite}@keyframes blink{50%{border-color:transparent}}
.hint{color:var(--mute);font-size:14px;margin:12px 0}
#ta{position:absolute;opacity:0;pointer-events:none;left:0;top:0}
.search{display:flex;gap:10px;margin-bottom:20px;max-width:520px}
.bgrid{align-items:start;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px}
.book{display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;background:none;border:0;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.cover{position:relative;aspect-ratio:2/3;border-radius:4px 10px 10px 4px;background:linear-gradient(135deg,var(--teal-d),#0d3d39);overflow:hidden;box-shadow:inset 6px 0 0 rgba(0,0,0,.25),0 8px 18px rgba(0,0,0,.5);display:flex;align-items:flex-end;padding:12px;color:#fff;font-weight:600;font-size:14px;transition:transform .12s}
.cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.cover img+span{display:none}
.book:hover .cover{transform:translateY(-4px)}
.book b{display:block;font-size:14px;margin-top:10px;line-height:1.3}.book small{color:var(--mute)}
.prog{font-size:12px;color:var(--teal);margin-top:4px;display:block}
.snd,.shk{background:none;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}.snd.off,.shk.off{color:var(--mute)}
.paper.shake{animation:shake .28s;border-color:var(--red)}@keyframes shake{20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
.me{flex-wrap:wrap;justify-content:flex-end}
.loading{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;place-items:center;z-index:10;text-align:center;line-height:1.7}.loading div{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 36px}
.spin{width:34px;height:34px;border:4px solid var(--line);border-top-color:var(--teal);border-radius:50%;margin:0 auto 14px;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
.toast.ok{background:#12301f;border-color:var(--green);color:#d5ffe5}
.toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#3a1515;border:1px solid var(--red);color:#ffd5d5;padding:12px 18px;border-radius:12px;z-index:11;display:none;max-width:min(560px,92vw);font-size:14px;line-height:1.5;cursor:pointer}
.players{display:grid;gap:10px;margin:18px 0}
.pl{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.pl .t{display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px}.pl .bar{margin:0}.pl.mine .bar i{background:var(--amber)}
.code{font-family:'JetBrains Mono',monospace;font-size:44px;letter-spacing:.2em;font-weight:600;background:var(--card);border:2px dashed var(--teal);border-radius:14px;padding:10px 24px;display:inline-block;margin:10px 0 18px}
.big{text-align:center;padding:30px 0}.big .num{font-size:clamp(60px,12vw,110px);font-weight:800;line-height:1;color:var(--teal)}
.res{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin:24px 0}.res div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 28px}
.res small{display:block;color:var(--mute)}.res b{font-size:30px}
.count{position:fixed;inset:0;background:rgba(10,18,24,.85);display:none;place-items:center;color:#fff;font-size:140px;font-weight:800;z-index:9}
@media(max-width:600px){.paper{font-size:17px;padding:16px}header{padding:12px 16px}.me span{display:none}}
</style></head><body>
<header id="hdr"><div class="logo" onclick="go('home')"><span class="key">T</span>Type You Want</div>
<div class="me"><button class="snd" onclick="toggleSnd()"></button><button class="shk" onclick="toggleShk()"></button><span id="best"></span><b id="uname" onclick="go('home')" style="cursor:pointer"></b><button onclick="logout()">Log out</button></div></header>
<main>

<section class="view on" id="auth">
  <div class="card">
    <div class="logo" style="margin-bottom:6px"><span class="key">T</span>Type You Want</div>
    <div class="tabs"><button id="tlogin" class="on" onclick="authTab('login')">Log in</button><button id="tsign" onclick="authTab('signup')">Create account</button></div>
    <label for="auser">Username</label><input type="text" id="auser" maxlength="16" autocomplete="username" placeholder="e.g. vikkash_m">
    <label for="apass">Password</label><input type="password" id="apass" autocomplete="current-password" maxlength="64" placeholder="At least 6 characters">
    <div id="a-confirm" style="display:none"><label for="apass2">Confirm password</label><input type="password" id="apass2" autocomplete="new-password" maxlength="64" placeholder="Type the password again"></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:12px;cursor:pointer"><input type="checkbox" id="ashow"> Show password</label>
    <button class="btn" id="abtn" onclick="submitAuth()">Log in</button>
    <div class="err" id="aerr"></div>
    <div class="note">Your results and book progress are saved to your account. There is no email, so keep your password safe.</div>
  </div>
</section>

<section class="view" id="home">
  <h1 id="hello"></h1>
  <p class="sub">Your personal page. Practise with a timer, type through real books, or race your friends.</p>
  <div class="kpis" id="kpis"></div>
  <h3>Start typing</h3>
  <div class="grid">
    <button class="mode" onclick="go('timed')"><span class="ico">⏱</span><b>Timed test</b><span>30 seconds, 1 or 2 minutes. See speed and accuracy at the end.</span></button>
    <button class="mode" onclick="go('library')"><span class="ico">📚</span><b>Book library</b><span>Thousands of real books. Pick one and type it page by page.</span></button>
    <button class="mode" onclick="go('friends')"><span class="ico">👥</span><b>Type with friends</b><span>Create a room, share the code, race live from different systems.</span></button>
    <button class="mode" onclick="go('own')"><span class="ico">✍️</span><b>My own text</b><span>Paste anything you want to practise: notes, lyrics, code.</span></button>
  </div>
  <h3>Recent results</h3><div class="hist" id="hist"></div>
</section>

<section class="view" id="timed">
  <button class="back" onclick="go('home')">← Back</button><h2>Timed test</h2><p class="sub">Choose a duration. The timer starts on your first key.</p>
  <div class="row" id="times"></div><button class="btn" onclick="startTimed()">Start test</button>
</section>

<section class="view" id="library">
  <button class="back" onclick="go('home')">← Back</button><h2>Book library</h2><p class="sub">Pick a book and type it page by page, or add your own .txt book.</p>
  <div class="search"><input type="text" id="bq" placeholder="Search books, e.g. Sherlock, Dracula, Austen" onkeydown="if(event.key==='Enter')loadBooks()"><button class="btn" onclick="loadBooks()">Search</button></div>
  <div class="row"><label class="btn alt" style="cursor:pointer">+ Add a book (.txt)<input type="file" id="bfile" accept=".txt,text/plain" hidden onchange="addBook(this)"></label></div>
  <div id="cont"></div><h3 id="bhead">Popular books</h3><div class="bgrid" id="bgrid"></div><div class="err" id="berr"></div>
</section>

<section class="view" id="own">
  <button class="back" onclick="go('home')">← Back</button><h2>My own text</h2><p class="sub">Paste or write the text you want to type.</p>
  <textarea class="own" id="owntext" placeholder="Paste your text here…"></textarea><button class="btn" onclick="startOwn()">Start typing</button>
</section>

<section class="view" id="friends">
  <button class="back" onclick="leaveRoom()">← Back</button><h2>Type with friends</h2><p class="sub">Everyone opens this same website and logs in. One person creates a room, the others join with the code.</p>
  <div id="f-enter">
    <div class="row"><button class="btn" onclick="createRoom()">Create room</button>
      <input type="text" id="jcode" placeholder="Room code" maxlength="4" style="max-width:140px;text-transform:uppercase">
      <button class="btn alt" onclick="joinRoom()">Join room</button></div>
    <div class="err" id="ftoast"></div>
  </div>
  <div id="f-lobby" style="display:none">
    <div>Room code. Share it with your friends:</div><div class="code" id="rcode">----</div>
    <div class="players" id="lobbyPlayers"></div>
    <div id="hostCtl"><p class="hint">Text for this race:</p><div class="row" id="rtext"></div><button class="btn" id="startRace" onclick="hostStart()">Start race</button></div>
    <p class="hint" id="waitHost" style="display:none">Waiting for the host to start the race…</p>
  </div>
</section>

<section class="view" id="play">
  <div class="stats"><div class="stat"><small>Speed</small><b id="s-wpm">0</b> WPM</div><div class="stat"><small>Accuracy</small><b id="s-acc">100</b>%</div><div class="stat"><small id="s-lbl">Time</small><b id="s-time">0</b>s</div></div>
  <div class="bar"><i id="pbar"></i></div>
  <div class="ptitle" id="ptitle"></div>
  <div class="paper" id="paper" onclick="ta.focus()"></div><textarea id="ta" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
  <div class="players" id="racePlayers"></div>
  <p class="hint" id="phint">Click the text and start typing. Backspace works.</p>
  <div class="row"><button class="btn alt" onclick="quit()">Quit</button><button class="snd" onclick="toggleSnd()"></button><button class="shk" onclick="toggleShk()"></button></div>
</section>

<section class="view" id="result">
  <div class="big"><div>Your speed</div><div class="num" id="r-wpm">0</div><div>words per minute</div></div>
  <div class="res"><div><small>Accuracy</small><b id="r-acc"></b></div><div><small>Characters</small><b id="r-chars"></b></div><div><small>Mistakes</small><b id="r-err"></b></div><div><small>Time</small><b id="r-time"></b></div></div>
  <div id="r-rank"></div><div class="row" style="justify-content:center" id="r-btns"></div>
</section>
</main>
<div class="count" id="count"></div>
<div class="loading" id="loading"><div><div class="spin"></div><span id="ltxt">Opening book…</span><br><small style="color:var(--mute)">First time can take up to 30 seconds. Next time it opens instantly.</small></div></div>
<div class="toast" id="toast" onclick="this.style.display='none'"></div>

<script>
const $=id=>document.getElementById(id), ta=$('ta');
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const WORDS="the of and to in is you that it he was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much before go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why help put different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually".split(' ');
let sndOn=localStorage.getItem('tyw_snd')!=='0',actx=null;
let shkOn=localStorage.getItem('tyw_shk')!=='0';
function shake(){if(!shkOn)return;try{navigator.vibrate&&navigator.vibrate(70)}catch{}const p=$('paper');p.classList.remove('shake');void p.offsetWidth;p.classList.add('shake')}
function toggleShk(){shkOn=!shkOn;localStorage.setItem('tyw_shk',shkOn?'1':'0');paintSnd();if(shkOn)shake();ta.focus()}
function paintSnd(){document.querySelectorAll('.shk').forEach(b=>{b.textContent=shkOn?'📳 Shake on':'📴 Shake off';b.classList.toggle('off',!shkOn)});document.querySelectorAll('.snd').forEach(b=>{b.textContent=sndOn?'🔊 Sound on':'🔇 Sound off';b.classList.toggle('off',!sndOn)})}
function toggleSnd(){sndOn=!sndOn;localStorage.setItem('tyw_snd',sndOn?'1':'0');paintSnd();if(sndOn)tone('key');ta.focus()}
function tone(kind){if(!sndOn)return;try{actx=actx||new(window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume();const t=actx.currentTime,sr=actx.sampleRate;
  if(kind==='done'){[660,880,1100].forEach((fr,i)=>{const o=actx.createOscillator(),g=actx.createGain();o.frequency.value=fr;g.gain.setValueAtTime(.12,t+i*.1);g.gain.exponentialRampToValueAtTime(.001,t+i*.1+.3);o.connect(g);g.connect(actx.destination);o.start(t+i*.1);o.stop(t+i*.1+.32)});return}
  const len=Math.floor(.035*sr),buf=actx.createBuffer(1,len,sr),d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3);
  const n=actx.createBufferSource();n.buffer=buf;const f=actx.createBiquadFilter();f.type='bandpass';f.frequency.value=kind==='space'?900:kind==='err'?350:2400;f.Q.value=1.1;
  const g=actx.createGain();g.gain.value=kind==='back'?.3:.7;n.connect(f);f.connect(g);g.connect(actx.destination);n.start(t);
  const o=actx.createOscillator(),og=actx.createGain();o.type=kind==='err'?'sawtooth':'sine';o.frequency.setValueAtTime(kind==='err'?160:kind==='space'?110:190,t);o.frequency.exponentialRampToValueAtTime(60,t+.05);
  og.gain.setValueAtTime(kind==='err'?.1:.22,t);og.gain.exponentialRampToValueAtTime(.001,t+.07);o.connect(og);og.connect(actx.destination);o.start(t);o.stop(t+.08)}catch{}}
paintSnd();
function toast(m,ok){const t=$('toast');t.className='toast'+(ok?' ok':'');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',9000)}
let token=localStorage.getItem('tyw_token')||'',user=null,view='auth',mode=null,secs=30,room=null,ws=null,myId=null,text='',st=null,timer=null;
const show=v=>{document.querySelectorAll('.view').forEach(e=>e.classList.toggle('on',e.id===v));view=v;scrollTo(0,0)};
async function api(p,body){const r=await fetch(p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body&&JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(r.status===401&&token&&p!=='/api/me'){logout();}if(!r.ok)throw new Error(d.error||'Request failed');return d}
function go(v){if(v==='library')openLibrary();show(v)}

// ---------- accounts ----------
let authMode='login';
function authTab(m){authMode=m;$('tlogin').classList.toggle('on',m==='login');$('tsign').classList.toggle('on',m==='signup');$('a-confirm').style.display=m==='signup'?'block':'none';
  $('abtn').textContent=m==='login'?'Log in':'Create account';$('apass').autocomplete=m==='login'?'current-password':'new-password';$('aerr').textContent=''}
$('ashow').addEventListener('change',e=>{$('apass').type=$('apass2').type=e.target.checked?'text':'password'});
['auser','apass','apass2'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')submitAuth()}));
async function submitAuth(){const username=$('auser').value.trim(),password=$('apass').value;$('aerr').textContent='';
  if(!username||!password){$('aerr').textContent='Enter your username and password.';return}
  if(authMode==='signup'&&password!==$('apass2').value){$('aerr').textContent='The two passwords do not match.';return}
  $('abtn').disabled=true;
  try{const d=await api(authMode==='login'?'/api/login':'/api/signup',{username,password});token=d.token;localStorage.setItem('tyw_token',token);
    $('apass').value=$('apass2').value='';enter(d.user);show('home')}
  catch(e){$('aerr').textContent=e.message}$('abtn').disabled=false}
function enter(u){user=u;$('hdr').classList.add('on');$('uname').textContent=u.name;$('best').textContent=u.best?'Best '+u.best+' WPM':'';renderHome()}
function renderHome(){const u=user,all=u.history||[],h=all.slice(0,10),avg=k=>Math.round(h.reduce((a,x)=>a+x[k],0)/h.length);
  $('hello').innerHTML='Welcome, '+esc(u.name)+'.<br>What do you want to type?';
  $('kpis').innerHTML=[['Best speed',u.best?u.best+' WPM':'-'],['Average speed',h.length?avg('wpm')+' WPM':'-'],['Average accuracy',h.length?avg('acc')+'%':'-'],['Tests completed',u.tests||0]].map(([a,b])=>\`<div class="kpi"><small>\${a}</small><b>\${b}</b></div>\`).join('');
  $('hist').innerHTML=all.length?all.slice(0,8).map(x=>\`<div><span>\${esc(x.label)}</span><span>\${x.wpm} WPM</span><span>\${x.acc}%</span><span>\${new Date(x.at).toLocaleDateString()}</span></div>\`).join(''):'<div><span>No results yet. Take a test and your progress will show here.</span></div>'}
async function boot(){if(!token)return show('auth');try{enter((await api('/api/me')).user);show('home')}catch{token='';localStorage.removeItem('tyw_token');show('auth')}}
function logout(){const t=token;token='';user=null;localStorage.removeItem('tyw_token');
  if(t)fetch('/api/logout',{method:'POST',headers:{Authorization:'Bearer '+t}}).catch(()=>{});
  if(ws){ws.onclose=null;ws.close();ws=null}$('hdr').classList.remove('on');authTab('login');show('auth')}

// ---------- timed ----------
$('times').innerHTML=[30,60,120].map(s=>\`<button class="chip \${s===30?'on':''}" onclick="secs=\${s};[...$('times').children].forEach(c=>c.classList.remove('on'));this.classList.add('on')">\${s<60?s+' seconds':s/60+(s===60?' minute':' minutes')}</button>\`).join('');
const randWords=n=>Array.from({length:n},()=>WORDS[Math.random()*WORDS.length|0]).join(' ');
function startTimed(){begin({kind:'timed',text:randWords(300),limit:secs,back:'timed'})}
function startOwn(){const t=$('owntext').value.replace(/\\s+/g,' ').trim();if(t.length<10){$('owntext').focus();return}begin({kind:'own',text:t,back:'own'})}

// ---------- library ----------
const hue=id=>{let s=0;for(const c of String(id))s+=c.charCodeAt(0);return s*37%360};
const coverOf=id=>/^\\d+$/.test(String(id))?\`https://www.gutenberg.org/cache/epub/\${id}/pg\${id}.cover.medium.jpg\`:'';
function coverHTML(b){const x=hue(b.id);return \`<div class="cover" style="background:linear-gradient(135deg,hsl(\${x} 45% 30%),hsl(\${x} 50% 13%))">\${b.cover?\`<img src="\${b.cover}" alt="" loading="lazy" onerror="this.remove()">\`:''}<span>\${esc(b.title.slice(0,50))}</span></div>\`}
const bookCard=(b,extra='')=>\`<button class="book" onclick="openBook('\${b.id}')">\${coverHTML(b)}<b>\${esc(b.title.slice(0,70))}</b><small>\${esc(b.author||'')}</small>\${extra}</button>\`;
function openLibrary(){const p=Object.entries(user.progress||{}).sort((a,b)=>b[1].at-a[1].at).slice(0,6),mine=user.library||[];
  $('cont').innerHTML=(p.length?\`<h3>Continue reading</h3><div class="bgrid">\${p.map(([id,b])=>bookCard({id,title:b.title,author:b.author,cover:coverOf(id)},\`<span class="prog">Page \${Math.min(b.page+1,b.total)} of \${b.total}</span>\`)).join('')}</div>\`:'')
    +(mine.length?\`<h3>My books</h3><div class="bgrid">\${mine.map(b=>bookCard(b)).join('')}</div>\`:'');
  if(!$('bgrid').children.length)loadBooks()}
async function loadBooks(){const q=$('bq').value.trim();$('berr').textContent='';$('bgrid').innerHTML='<span class="hint">Loading books…</span>';$('bhead').textContent=q?'Results for "'+q+'"':'Popular books';
  try{const l=await api('/api/books?q='+encodeURIComponent(q));$('bgrid').innerHTML=l.length?l.map(b=>bookCard(b)).join(''):'<span class="hint">No books found. Try another word.</span>'}
  catch(e){$('bgrid').innerHTML='';$('berr').textContent='Could not load books: '+e.message}}
async function addBook(inp){const f=inp.files[0];inp.value='';if(!f)return;if(f.size>6e6)return toast('That file is too big (max 6 MB).');
  const L=$('loading');L.style.display='grid';
  try{const d=await api('/api/upload',{title:f.name.replace(/\\.[^.]+$/,''),text:await f.text()});user.library=d.user.library;L.style.display='none';toast('Book added: '+d.book.title,true);openLibrary()}
  catch(e){L.style.display='none';toast(e.message)}}
async function openBook(id,pg){const L=$('loading');L.style.display='grid';
  try{const b=await api('/api/book/'+id);let p=pg??(user.progress[id]?user.progress[id].page:0);if(p>=b.total)p=0;
    const d=await api('/api/book/'+id+'/page/'+p);L.style.display='none';begin({kind:'book',book:b,page:p,text:d.text,back:'library'})}
  catch(e){L.style.display='none';toast('Could not open the book: '+e.message+' You can also download its .txt from gutenberg.org and add it with the "Add a book" button.');show('library')}}

// ---------- engine ----------
function begin(cfg){mode=cfg;text=cfg.text;st={start:0,keys:0,err:0,prev:0,done:false};ta.value='';
  $('racePlayers').innerHTML='';$('s-wpm').textContent=0;$('s-acc').textContent=100;$('pbar').style.width=0;
  $('ptitle').textContent=cfg.kind==='book'?cfg.book.title+' · page '+(cfg.page+1)+' of '+cfg.book.total:'';
  $('s-lbl').textContent=cfg.limit?'Time left':'Time';$('s-time').textContent=cfg.limit||0;$('phint').textContent='Click the text and start typing. Backspace works.';
  show('play');render();ta.focus();clearInterval(timer);timer=setInterval(tick,200)}
function render(){const v=ta.value;let h='',w='';
  for(let i=0;i<text.length;i++){const ch=text[i],k=i<v.length?(v[i]===ch?'ok':'bad'):'';
    if(i===v.length)w+='<span class="cur"></span>';w+=\`<span class="\${k}">\${esc(ch)}</span>\`;
    if(ch===' '){h+=\`<span class="w">\${w}</span>\`;w=''}}
  if(w)h+=\`<span class="w">\${w}</span>\`;$('paper').innerHTML=h;
  const c=$('paper').querySelector('.cur');if(c)$('paper').scrollTop=Math.max(0,c.offsetTop-70)}
ta.addEventListener('input',()=>{if(!st||st.done)return;if(!st.start)st.start=Date.now();
  if(ta.value.length>text.length)ta.value=ta.value.slice(0,text.length);
  if(ta.value.length>st.prev){const i=ta.value.length-1;st.keys++;const bad=ta.value[i]!==text[i];if(bad)st.err++;tone(bad?'err':text[i]===' '?'space':'key');if(bad)shake()}else if(ta.value.length<st.prev)tone('back');
  st.prev=ta.value.length;render();if(ta.value.length>=text.length)finish()});
ta.addEventListener('paste',e=>e.preventDefault());
function calc(){const v=ta.value;let ok=0;for(let i=0;i<v.length;i++)if(v[i]===text[i])ok++;
  const el=st.start?(Date.now()-st.start)/60000:0,wpm=el>0.0008?Math.round(ok/5/el):0,acc=st.keys?Math.max(0,Math.round((st.keys-st.err)/st.keys*100)):100;
  return{wpm,acc,el,pct:Math.round(v.length/text.length*100)}}
function tick(){if(!st||st.done||view!=='play')return;const c=calc();$('s-wpm').textContent=c.wpm;$('s-acc').textContent=c.acc;
  if(mode.limit){const left=st.start?Math.max(0,mode.limit-Math.floor((Date.now()-st.start)/1000)):mode.limit;$('s-time').textContent=left;$('pbar').style.width=st.start?(100-left/mode.limit*100)+'%':'0%';if(st.start&&left<=0)finish()}
  else{$('s-time').textContent=st.start?Math.floor((Date.now()-st.start)/1000):0;$('pbar').style.width=c.pct+'%'}
  if(mode.kind==='race'&&st.start)wsend({t:'progress',pct:c.pct,wpm:c.wpm,acc:c.acc,done:false})}
function finish(){if(st.done)return;st.done=true;clearInterval(timer);const c=calc();
  tone('done');if(mode.kind==='race')wsend({t:'progress',pct:100,wpm:c.wpm,acc:c.acc,done:true});
  if(ta.value.length>=10)api('/api/result',{kind:mode.kind,wpm:c.wpm,acc:c.acc,label:resultLabel()}).then(d=>{d.user.progress=user.progress;enter(d.user)}).catch(()=>{});
  $('r-wpm').textContent=c.wpm;$('r-acc').textContent=c.acc+'%';$('r-chars').textContent=ta.value.length;$('r-err').textContent=st.err;$('r-time').textContent=Math.round(c.el*60)+'s';
  let btns='';$('r-rank').innerHTML='';
  if(mode.kind==='book'){const b=mode.book,next=mode.page+1;const np=next>=b.total?0:next;user.progress[b.id]={title:b.title,author:b.author,page:np,total:b.total,at:Date.now()};api('/api/progress',{bookId:b.id,title:b.title,author:b.author,page:np,total:b.total}).catch(()=>{});
    if(next<b.total)btns+=\`<button class="btn" onclick="openBook('\${b.id}',\${next})">Next page</button>\`;
    btns+=\`<button class="btn alt" onclick="openBook('\${b.id}',\${mode.page})">Retry page</button><button class="btn alt" onclick="go('library')">Library</button>\`}
  else if(mode.kind==='race'){btns='<button class="btn alt" onclick="show(\\'friends\\')">Back to room</button>';$('r-rank').innerHTML='<p class="hint" style="text-align:center">Live ranking:</p><div class="players" id="rank"></div>';renderRank()}
  else btns=\`<button class="btn" onclick="\${mode.kind==='timed'?'startTimed()':'startOwn()'}">Try again</button><button class="btn alt" onclick="go('home')">Home</button>\`;
  $('r-btns').innerHTML=btns;show('result')}
const resultLabel=()=>mode.kind==='timed'?mode.limit+'s timed test':mode.kind==='book'?mode.book.title.slice(0,40)+' · page '+(mode.page+1):mode.kind==='race'?'Friends race':'My own text';
function quit(){clearInterval(timer);st=null;if(mode&&mode.kind==='race')show('friends');else go(mode?mode.back:'home')}

// ---------- friends ----------
const wsend=o=>ws&&ws.readyState===1&&ws.send(JSON.stringify({...o,token}));
function connect(cb){if(ws&&ws.readyState===1)return cb();$('ftoast').textContent='';
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.onopen=cb;
  ws.onerror=()=>$('ftoast').textContent='Cannot reach the server. Make sure "npm start" is running.';
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.t==='joined'){myId=m.id;$('f-enter').style.display='none';$('f-lobby').style.display='block'}
    else if(m.t==='error')$('ftoast').textContent=m.msg;
    else if(m.t==='room'){room=m;renderRoom()}
    else if(m.t==='start')countdown(m.text)};
  ws.onclose=()=>{room=null;$('f-enter').style.display='block';$('f-lobby').style.display='none'}}
const createRoom=()=>connect(()=>wsend({t:'create'}));
function joinRoom(){const c=$('jcode').value.trim().toUpperCase();if(c.length<4){$('ftoast').textContent='Enter the 4-letter room code.';return}connect(()=>wsend({t:'join',code:c}))}
function leaveRoom(){if(ws){ws.onclose=null;ws.close();ws=null}room=null;$('f-enter').style.display='block';$('f-lobby').style.display='none';go('home')}
let raceChoice='words';
async function pickText(){if(raceChoice==='own')return $('owntext').value.replace(/\\s+/g,' ').trim()||randWords(45);
  if(raceChoice==='book'){try{const id=[11,1342,1661,84,2701,174][Math.random()*6|0],b=await api('/api/book/'+id);return(await api('/api/book/'+id+'/page/'+(20+Math.random()*Math.max(1,b.total-30)|0))).text}catch{return randWords(45)}}
  return randWords(45)}
const playersHTML=()=>room.players.map(p=>\`<div class="pl \${p.id===myId?'mine':''}"><div class="t"><span>\${esc(p.name)}\${p.id===room.host?' (host)':''}\${p.id===myId?' (you)':''}</span><span>\${p.wpm} WPM</span></div><div class="bar"><i style="width:\${p.pct}%"></i></div></div>\`).join('');
function renderRank(){const el=$('rank');if(!el||!room)return;const r=[...room.players].sort((a,b)=>(b.done-a.done)||b.wpm-a.wpm);
  el.innerHTML=r.map((p,i)=>\`<div class="pl \${p.id===myId?'mine':''}"><div class="t"><span>\${i+1}. \${esc(p.name)}</span><span>\${p.done?p.wpm+' WPM · '+p.acc+'%':'still typing… '+p.pct+'%'}</span></div></div>\`).join('')}
function renderRoom(){$('rcode').textContent=room.code;const host=room.host===myId;$('lobbyPlayers').innerHTML=playersHTML();
  $('hostCtl').style.display=host?'block':'none';$('waitHost').style.display=host?'none':'block';
  if(host&&!$('rtext').children.length)$('rtext').innerHTML=[['words','Random words'],['book','Random book page'],['own','My own text']].map(([k,l])=>\`<button class="chip \${k===raceChoice?'on':''}" onclick="raceChoice='\${k}';[...$('rtext').children].forEach(c=>c.classList.remove('on'));this.classList.add('on')">\${l}</button>\`).join('');
  if(!host)$('rtext').innerHTML='';
  if(view==='play'&&mode&&mode.kind==='race')$('racePlayers').innerHTML=playersHTML();if(view==='result')renderRank()}
async function hostStart(){$('startRace').disabled=true;wsend({t:'start',text:await pickText()});setTimeout(()=>$('startRace').disabled=false,1500)}
function countdown(t){const c=$('count');c.style.display='grid';let n=3;c.textContent=n;
  const iv=setInterval(()=>{n--;if(n>0)c.textContent=n;else{clearInterval(iv);c.style.display='none';begin({kind:'race',text:t,back:'friends'});$('racePlayers').innerHTML=playersHTML();$('phint').textContent='Go! Type as fast as you can.'}},1000)}
boot();
</script></body></html>
`;

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (!p.startsWith('/api/')) {
    if (p !== '/') { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML);
  }
  try {
    const ip = req.socket.remoteAddress || '';
    if (req.method === 'POST' && p === '/api/signup') {
      const b = await readBody(req), un = String(b.username || '').trim(), pw = String(b.password || ''), key = un.toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(un)) return send(res, 400, { error: 'Username must be 3 to 16 letters, numbers or underscore.' });
      if (pw.length < 6 || pw.length > 64) return send(res, 400, { error: 'Password must be 6 to 64 characters.' });
      if (RESERVED.includes(key) || db.users[key]) return send(res, 400, { error: 'That username is already taken.' });
      db.users[key] = makeUser(un, pw); const token = newSession(key); save();
      return send(res, 200, { token, user: pub(db.users[key]) });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req), key = String(b.username || '').trim().toLowerCase(), k = key + '|' + ip;
      if (locked(k)) return send(res, 429, { error: 'Too many wrong attempts. Wait one minute and try again.' });
      const u = !RESERVED.includes(key) && db.users[key];
      if (!u || !u.hash || !checkPw(u, String(b.password || ''))) { failed(k); return send(res, 400, { error: 'Wrong username or password.' }); }
      delete fails[k]; const token = newSession(key); save();
      return send(res, 200, { token, user: pub(u) });
    }
    if (req.method === 'POST' && p === '/api/logout') { delete db.sessions[tokenOf(req)]; save(); return send(res, 200, { ok: true }); }
    const user = userByToken(tokenOf(req));
    if (!user) return send(res, 401, { error: 'Please log in.' });
    if (p === '/api/me') return send(res, 200, { user: pub(user) });
    if (req.method === 'POST' && p === '/api/progress') {
      const b = await readBody(req); user.progress[String(b.bookId)] = { title: String(b.title || '').slice(0, 120), author: String(b.author || '').slice(0, 80), page: +b.page || 0, total: +b.total || 0, at: Date.now() };
      save(); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/result') {
      const b = await readBody(req), w = Math.max(0, Math.min(400, Math.round(+b.wpm || 0))), a = Math.max(0, Math.min(100, Math.round(+b.acc || 0)));
      if (w > 0) {
        user.tests++; if (w > user.best) user.best = w;
        user.history.unshift({ at: Date.now(), kind: String(b.kind || '').slice(0, 12), label: String(b.label || '').slice(0, 60), wpm: w, acc: a });
        user.history = user.history.slice(0, 30); save();
      }
      return send(res, 200, { user: pub(user) });
    }
    if (p === '/api/books') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const local = CATALOG.filter(([, t, a]) => !q || (t + ' ' + a).toLowerCase().includes(q)).map(([id, t, a]) => ({ id: String(id), title: t, author: a, cover: coverOf(id) }));
      if (!q) return send(res, 200, local);
      let live = [];
      try { const d = await (await getJ('https://gutendex.com/books/?languages=en&search=' + encodeURIComponent(q), 8000, 1)).json();
        live = d.results.slice(0, 24).map(b => ({ id: String(b.id), title: b.title, author: (b.authors[0] || {}).name || 'Unknown', cover: (b.formats || {})['image/jpeg'] || coverOf(b.id) })); } catch {}
      const seen = new Set(local.map(b => b.id));
      return send(res, 200, [...local, ...live.filter(b => !seen.has(b.id))].slice(0, 36));
    }
    if (req.method === 'POST' && p === '/api/upload') {
      const b = await readBody(req, 8e6), txt = clean(String(b.text || ''), true);
      if (txt.length < 1500) return send(res, 400, { error: 'That file has too little text. Add a book of at least a few pages.' });
      const pages = paginate(txt), id = 'u' + crypto.randomBytes(5).toString('hex'), title = String(b.title || 'My book').trim().slice(0, 80) || 'My book';
      const book = { id, title, author: 'My upload', pages }; fs.writeFileSync(path.join(CACHE, id + '.json'), JSON.stringify(book)); books[id] = book;
      user.library = user.library || []; user.library.unshift({ id, title, author: 'My upload' }); user.library = user.library.slice(0, 30); save();
      return send(res, 200, { user: pub(user), book: { id, title } });
    }
    let m;
    if ((m = p.match(/^\/api\/book\/([A-Za-z0-9_-]{1,24})$/))) { const b = await loadBook(m[1]); return send(res, 200, { id: b.id, title: b.title, author: b.author, total: b.pages.length }); }
    if ((m = p.match(/^\/api\/book\/([A-Za-z0-9_-]{1,24})\/page\/(\d+)$/))) { const b = await loadBook(m[1]); const t = b.pages[+m[2]]; return t ? send(res, 200, { text: t }) : send(res, 404, { error: 'No such page.' }); }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

// ---------- multiplayer rooms ----------
const wss = new WebSocketServer({ server }), rooms = {}; let nextId = 1;
const newCode = () => { let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms[c]); return c; };
function broadcast(room) {
  const msg = JSON.stringify({ t: 'room', code: room.code, host: room.host, started: room.started,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, pct: p.pct, wpm: p.wpm, acc: p.acc, done: p.done })) });
  room.players.forEach(p => p.ws.readyState === 1 && p.ws.send(msg));
}
wss.on('connection', ws => {
  const me = { id: nextId++, ws, name: 'Player', pct: 0, wpm: 0, acc: 100, done: false, room: null };
  const reply = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const u = userByToken(m.token); if (!u) return reply({ t: 'error', msg: 'Please log in again.' }); me.name = u.name;
    if (m.t === 'create') {
      const code = newCode(); rooms[code] = { code, host: me.id, started: false, players: new Map([[me.id, me]]) }; me.room = rooms[code];
      reply({ t: 'joined', id: me.id }); broadcast(me.room);
    } else if (m.t === 'join') {
      const room = rooms[String(m.code || '').toUpperCase()];
      if (!room) return reply({ t: 'error', msg: 'Room not found. Check the code.' });
      if (room.started) return reply({ t: 'error', msg: 'Race already started.' });
      if (room.players.size >= 8) return reply({ t: 'error', msg: 'Room is full (8 players).' });
      room.players.set(me.id, me); me.room = room; reply({ t: 'joined', id: me.id }); broadcast(room);
    } else if (m.t === 'start' && me.room && me.room.host === me.id) {
      const room = me.room; room.started = true;
      room.players.forEach(p => { p.pct = 0; p.wpm = 0; p.acc = 100; p.done = false; });
      room.players.forEach(p => p.ws.readyState === 1 && p.ws.send(JSON.stringify({ t: 'start', text: String(m.text || '').slice(0, 1500) })));
      broadcast(room);
    } else if (m.t === 'progress' && me.room) {
      Object.assign(me, { pct: m.pct, wpm: m.wpm, acc: m.acc, done: !!m.done });
      if ([...me.room.players.values()].every(p => p.done)) me.room.started = false;
      broadcast(me.room);
    }
  });
  ws.on('close', () => {
    const room = me.room; if (!room) return; room.players.delete(me.id);
    if (!room.players.size) return delete rooms[room.code];
    if (room.host === me.id) room.host = [...room.players.keys()][0]; broadcast(room);
  });
});
if (process.argv.includes('--prefetch')) {
  // node server.js --prefetch  -> downloads all catalog books into the book-cache folder (run once on your own computer)
  (async () => {
    let ok = 0;
    for (const [id, t] of CATALOG) { try { await loadBook(String(id)); ok++; console.log('OK      ' + t); } catch (e) { console.log('FAILED  ' + t + ' - ' + e.message); } }
    console.log('\nDone: ' + ok + ' of ' + CATALOG.length + ' books saved in the book-cache folder.');
    process.exit();
  })();
} else server.listen(PORT, () => console.log('Type You Want running on http://localhost:' + PORT));
