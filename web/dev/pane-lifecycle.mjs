import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = (await readFile(new URL('../../desktop/plugin.js', import.meta.url), 'utf8'))
  .replace("import { host, SandboxedFrame } from '@hermes/plugin-sdk'", 'const { host, SandboxedFrame } = globalThis.__omniTest')
  .replace("import { jsx } from 'react/jsx-runtime'", 'const { jsx } = globalThis.__omniTest')
  .replace("import { useEffect, useRef, useState } from 'react'", 'const { useEffect, useRef, useState } = globalThis.__omniTest');
const values = new Map([['omniscience.livePane', '1']]);
globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
const registered = new Map();
let disposePlugin;
let opens = 0;
let closes = 0;
globalThis.__omniTest = {
  host: { openWorkspace: (_id, options) => {
    opens++;
    return () => { closes++; options.onClose(); };
  } },
  SandboxedFrame: () => null, jsx: () => null, useEffect: () => {}, useRef: (value) => ({ current: value }), useState: () => {},
};
const plugin = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
plugin.register({ register: (item) => { registered.set(item.id, item); return () => {}; }, onDispose: (fn) => { disposePlugin = fn; } });
assert.equal(opens, 0, 'old default must not reopen the sidebar');
const toggle = registered.get('toggle-pane').data.run;
toggle();
assert.equal(opens, 1, 'explicit toggle should open the pane');
assert.equal(values.get('omniscience.livePane.v2'), '1');
toggle();
assert.equal(closes, 1, 'second toggle should dispose the workspace');
assert.equal(values.get('omniscience.livePane.v2'), '0');
toggle();
disposePlugin();
assert.equal(closes, 2, 'unloading the plugin should close an open workspace');
console.log('PASS sidebar starts closed and opens/closes through workspace');
