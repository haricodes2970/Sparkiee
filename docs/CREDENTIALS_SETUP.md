# Optional credentials & one-time setups

Everything below is optional; Sparkiee works fully with text captions and
chirps without any of these.

## Local speech recognition (already installed)

```text
sparkiee assistant stt-setup --model large-v3-turbo
```

Idempotent; safe to re-run. Installs the venv under
`~/.local/share/sparkiee/stt/` and downloads the chosen model **once**, into
the shared Hugging Face cache (`~/.cache/huggingface/hub`) that every local
app can reuse — nothing is duplicated per project. `tiny.en` stays available
as the small fallback. Commands never touch the network: recognition runs
offline on the loaded model (resident in the daemon, so after the first
utterance replies take well under a second on the GPU).

GPU recognition additionally needs the CUDA runtime libraries once,
shared by every app too:

```text
~/.local/share/sparkiee/stt/venv/bin/python -m pip install --target \
  ~/.local/share/cuda-libs nvidia-cublas-cu12 nvidia-cudnn-cu12
```

Without them the recogniser falls back to CPU int8 and says so; it never
pretends the GPU worked. No audio ever leaves the machine.

## ElevenLabs voice (optional)

Give Sparky a real spoken voice instead of chirps:

```text
sparkiee voice setup
```

Non-echoing prompt (or pipe it: `echo "$KEY" | sparkiee voice setup`,
`ELEVENLABS_API_KEY=... sparkiee voice setup`). The key is stored outside the
repository in the user config directory with `0600` permissions. Verify with
`sparkiee voice status`, then test with `sparkiee voice test`.

## Wake word "Yo Spark" (needs external setup — honestly disabled now)

Status: `needs-setup` — requires all three, until then the hotkey path is
the supported way to talk to Sparky:

1. `npm i picovoice/porcupine` node module (wake listener dep)
2. A Picovoice Console AccessKey (free account): same 0600-file flow as the
   ElevenLabs key once wired — ask before use.
3. A trained keyword model: train "Yo Spark" on Picovoice Console for
   platform `linux_x86_64`, save as `sparkiee_linux.ppn`, place it under
   `~/.config/sparkiee/wake/sparkiee_linux.ppn`.

## NVIDIA API key (optional, not required today)

No current Sparkiee feature consumes it. If a future text-provider needs it,
it will follow the same never-echoed, store-outside-the-repo 0600 pattern.

## Controls cheat sheet

- `sparkiee ptt toggle` — start/stop push-to-talk capture (bound to
  Ctrl+Alt+Space via the GNOME media-keys fallback)
- `sparkiee assistant hotkey status|install|remove`
- Dashboard → assistant card: live state, last action, mic test, cancel
