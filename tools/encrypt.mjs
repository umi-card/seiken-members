// Encrypt _private/content.json -> data/content.enc.json with the data key in _private/datakey.txt.
//   node tools/encrypt.mjs                 re-encrypt content only
//   USERS='[{"name":"山田","pw":"..","role":"admin"},..]' node tools/encrypt.mjs --init
//                                          also create data/keys.json and an empty data/posts.enc.json
import fs from 'node:fs';
import { importDataKey, newDataKey, seal, randomId, makeUserEntry, normName, b64, ITER } from '../crypto.js';

const root = new URL('..', import.meta.url).pathname;
const p = (f) => root + f;

const keyFile = p('_private/datakey.txt');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, newDataKey() + '\n');
const raw = fs.readFileSync(keyFile, 'utf8').trim();
const K = await importDataKey(raw);

const content = JSON.parse(fs.readFileSync(p('_private/content.json'), 'utf8'));
fs.writeFileSync(p('data/content.enc.json'), JSON.stringify(await seal(K, content)));
console.log('wrote data/content.enc.json');

if (process.argv.includes('--init')) {
  const users = JSON.parse(process.env.USERS || '[]');
  if (!users.length) throw new Error('USERS is required');
  const keys = { v: 3, iter: ITER, salt: b64(crypto.getRandomValues(new Uint8Array(16))), users: {}, dir: null, tok: null };
  const dir = {};
  for (const u of users) {
    const uid = randomId(8);
    const name = normName(u.name);
    const { id, entry } = await makeUserEntry(u.pw, raw, { uid, name, role: u.role || 'member' }, keys);
    if (keys.users[id]) throw new Error(`duplicate password: ${name}`);
    keys.users[id] = entry;
    dir[uid] = name;
  }
  keys.dir = await seal(K, dir);
  fs.writeFileSync(p('data/keys.json'), JSON.stringify(keys, null, 1));
  const state = {
    posts: [],
    todo: {},
    // ToDo items live in the shared state so members can add and delete any of them
    todos: content.todo.flatMap((d) => d.items.map((i) => ({ ...i, date: d.date }))),
  };
  fs.writeFileSync(p('data/posts.enc.json'), JSON.stringify(await seal(K, state)));
  console.log('wrote data/keys.json, data/posts.enc.json');
}
