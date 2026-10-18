import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMusicLibrary, createFfprobeProbe, filenameStem, normalizeForMatch, resolveMusicRoots } from '../packages/core/src/music-library.mjs';

/** Probe stub: tags keyed by filename stem, so tests control metadata. */
function fakeProbe(tagsByStem = {}) {
  return async (filePath) => tagsByStem[path.basename(filePath)] ?? { title: null, artist: null, album: null, durationMs: null };
}

async function makeLibraryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-music-'));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('music roots resolve from env with an explicit homedir default', () => {
  assert.deepEqual(resolveMusicRoots({}), [path.join(os.homedir(), 'Music')]);
  assert.deepEqual(
    resolveMusicRoots({ SPARKIEE_MUSIC_ROOTS: '/tmp/a : /tmp/b' }),
    [path.resolve('/tmp/a'), path.resolve('/tmp/b')],
  );
  assert.throws(() => resolveMusicRoots({ SPARKIEE_MUSIC_ROOTS: ' : ' }), /no roots/);
});

test('normalization is case-, punctuation- and diacritic-insensitive', () => {
  assert.equal(normalizeForMatch('MADÍRA!'), 'madira');
  assert.equal(normalizeForMatch('  The   Madira '), 'the madira');
  assert.equal(normalizeForMatch(null), '');
  assert.equal(filenameStem('/x/Lunch Break.mp3'), 'Lunch Break');
});

test('library indexes mp3s recursively and ignores everything else', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await mkdir(path.join(fixture.root, 'album'));
    await writeFile(path.join(fixture.root, 'Madira.mp3'), 'x');
    await writeFile(path.join(fixture.root, 'album', 'Nanchaku.mp3'), 'x');
    await writeFile(path.join(fixture.root, 'notes.txt'), 'x');
    await writeFile(path.join(fixture.root, 'cover.png'), 'x');
    const library = createMusicLibrary({ roots: [fixture.root], probe: fakeProbe() });
    const status = await library.rescan({ force: true });
    assert.equal(status.trackCount, 2);
    assert.equal(status.lastError, null);
    assert.ok(status.scannedAt);
    assert.deepEqual(status.formats, ['mp3']);
    assert.deepEqual(status.roots, [{ path: fixture.root, available: true }]);
    const { tracks } = await library.list();
    assert.deepEqual(tracks.map((track) => track.file).sort(), ['Madira.mp3', 'Nanchaku.mp3']);
  } finally {
    await fixture.cleanup();
  }
});

test('symlinks are never followed, even when they stay inside the root', async () => {
  const fixture = await makeLibraryRoot();
  try {
    const outside = await makeLibraryRoot();
    await writeFile(path.join(outside.root, 'Secret.mp3'), 'x');
    await writeFile(path.join(fixture.root, 'Real.mp3'), 'x');
    await symlink(path.join(outside.root, 'Secret.mp3'), path.join(fixture.root, 'escape.mp3'));
    await symlink(path.join(fixture.root, 'Real.mp3'), path.join(fixture.root, 'inside-link.mp3'));
    await symlink(outside.root, path.join(fixture.root, 'dir-link'));
    const library = createMusicLibrary({ roots: [fixture.root], probe: fakeProbe() });
    const status = await library.rescan({ force: true });
    assert.equal(status.trackCount, 1, 'only the real file is indexed');
    const { tracks } = await library.list();
    assert.deepEqual(tracks.map((track) => track.file), ['Real.mp3']);
    await outside.cleanup();
  } finally {
    await fixture.cleanup();
  }
});

test('metadata comes from the probe with filename fallbacks', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await writeFile(path.join(fixture.root, 'Tagged.mp3'), 'x');
    await writeFile(path.join(fixture.root, 'Untagged Song.mp3'), 'x');
    const library = createMusicLibrary({
      roots: [fixture.root],
      probe: fakeProbe({
        'Tagged.mp3': { title: 'Madira', artist: 'Seedhe Maut', album: 'Nayaab', durationMs: 169_846 },
      }),
    });
    await library.rescan({ force: true });
    const { tracks } = await library.list();
    const tagged = tracks.find((track) => track.file === 'Tagged.mp3');
    const untagged = tracks.find((track) => track.file === 'Untagged Song.mp3');
    assert.equal(tagged.name, 'Madira');
    assert.equal(tagged.artist, 'Seedhe Maut');
    assert.equal(tagged.album, 'Nayaab');
    assert.equal(tagged.durationMs, 169_846);
    assert.equal(untagged.name, 'Untagged Song');
    assert.equal(untagged.title, null);
    assert.ok(tagged.id.match(/^[0-9a-f]{16}$/), 'opaque hex id');
    assert.equal(JSON.stringify(tracks).includes(fixture.root), false, 'no absolute paths in records');
  } finally {
    await fixture.cleanup();
  }
});

test('track ids are stable across rescans and survive file renames as new ids', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await writeFile(path.join(fixture.root, 'Madira.mp3'), 'x');
    const library = createMusicLibrary({ roots: [fixture.root], probe: fakeProbe() });
    await library.rescan({ force: true });
    const first = (await library.list()).tracks[0].id;
    await library.rescan({ force: true });
    const second = (await library.list()).tracks[0].id;
    assert.equal(first, second);
    await unlink(path.join(fixture.root, 'Madira.mp3'));
    await writeFile(path.join(fixture.root, 'Renamed.mp3'), 'x');
    await library.rescan({ force: true });
    const third = (await library.list()).tracks[0].id;
    assert.notEqual(first, third, 'id is keyed to the relative path');
  } finally {
    await fixture.cleanup();
  }
});

test('search handles exact, case, punctuation and token variations; duplicates come back together', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await writeFile(path.join(fixture.root, 'Madira.mp3'), 'x');
    await writeFile(path.join(fixture.root, 'Lunch Break.mp3'), 'x');
    await mkdir(path.join(fixture.root, 'live'));
    await writeFile(path.join(fixture.root, 'live', 'Madira.mp3'), 'x'); // duplicate title
    const library = createMusicLibrary({
      roots: [fixture.root],
      probe: fakeProbe({
        'Madira.mp3': { title: 'Madira', artist: null, album: null, durationMs: 1000 },
        'Lunch Break.mp3': { title: 'Lunch Break', artist: null, album: null, durationMs: 1000 },
      }),
    });
    await library.rescan({ force: true });

    const exact = library.search('madira');
    assert.equal(exact.length, 2, 'both same-title tracks are offered, never an arbitrary pick');
    assert.equal(exact.filter((track) => track.name === 'Madira').length, 2);

    const punctuated = library.search('lunch-break!');
    assert.ok(punctuated[0].name === 'Lunch Break', 'punctuation-insensitive exact match ranks first');

    const tokenOrder = library.search('break lunch');
    assert.equal(tokenOrder[0].name, 'Lunch Break', 'token containment matches reordered words');

    const withPrefix = library.search('the madira');
    assert.ok(withPrefix.some((track) => track.name === 'Madira'), 'leading filler words still match');

    const missing = library.search('utterly unknown song xyz');
    assert.deepEqual(missing, []);

    const nearMiss = library.search('madiraa');
    assert.equal(nearMiss[0]?.name, 'Madira', 'close miss offers a suggestion');
  } finally {
    await fixture.cleanup();
  }
});

test('missing root reports honestly and never crashes', async () => {
  const library = createMusicLibrary({ roots: ['/definitely/not/here'], probe: fakeProbe() });
  const status = await library.rescan({ force: true });
  assert.equal(status.trackCount, 0);
  assert.equal(status.roots[0].available, false);
  assert.deepEqual(await library.list(), { tracks: [], total: 0, query: '' });
});

test('resolvePath validates ids, containment, and files that vanished after indexing', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await writeFile(path.join(fixture.root, 'Madira.mp3'), 'x');
    const library = createMusicLibrary({ roots: [fixture.root], probe: fakeProbe() });
    await library.rescan({ force: true });
    const [track] = (await library.list()).tracks;
    const resolved = await library.resolvePath(track.id);
    assert.equal(resolved, path.join(fixture.root, 'Madira.mp3'));
    assert.equal(await library.resolvePath('../../etc/passwd'), null);
    assert.equal(await library.resolvePath('zzzz'), null);
    assert.equal(await library.resolvePath(`${track.id.slice(0, -1)}0`), null, 'unknown id');

    await unlink(path.join(fixture.root, 'Madira.mp3'));
    assert.equal(await library.resolvePath(track.id), null, 'deleted file is unavailable');
    assert.equal(await library.isAvailable(track.id), false);
  } finally {
    await fixture.cleanup();
  }
});

test('rescans are coalesced and honour the cooldown unless forced', async () => {
  const fixture = await makeLibraryRoot();
  try {
    await writeFile(path.join(fixture.root, 'Madira.mp3'), 'x');
    let probes = 0;
    const countingProbe = async (filePath) => {
      probes += 1;
      return { title: path.basename(filePath), artist: null, album: null, durationMs: null };
    };
    const library = createMusicLibrary({ roots: [fixture.root], probe: countingProbe, rescanCooldownMs: 60_000 });
    const [a, b] = await Promise.all([library.rescan({ force: true }), library.rescan({ force: true })]);
    assert.equal(probes, 1, 'concurrent rescans share one walk');
    assert.equal(a.trackCount, 1);
    assert.equal(b.trackCount, 1);

    await writeFile(path.join(fixture.root, 'Second.mp3'), 'x');
    const cooled = await library.rescan();
    assert.equal(cooled.trackCount, 1, 'cooldown blocks the unforced rescan');
    const forced = await library.rescan({ force: true });
    assert.equal(forced.trackCount, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('ffprobe probe reads duration and tolerates garbage', async () => {
  const probe = createFfprobeProbe();
  // Minimal valid WAV (44-byte header + 0.1s of silence): ffprobe reads
  // duration and honours no tags → null fields, never a throw.
  const wavHeader = Buffer.alloc(44);
  const sampleRate = 8000;
  const samples = sampleRate / 10;
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + samples * 2, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * 2, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(samples * 2, 40);
  const fixture = await makeLibraryRoot();
  try {
    const media = path.join(fixture.root, 'blip.wav');
    await writeFile(media, Buffer.concat([wavHeader, Buffer.alloc(samples * 2)]));
    const result = await probe(media);
    if (result === null) return; // ffprobe not installed: honest null, no throw
    assert.equal(result.title, null);
    assert.ok(Math.abs(result.durationMs - 100) < 40, `duration ~100ms, got ${result.durationMs}`);
    const missing = await probe(path.join(fixture.root, 'nope.mp3'));
    assert.equal(missing, null, 'missing file probes to null, never throws');
  } finally {
    await fixture.cleanup();
  }
});
