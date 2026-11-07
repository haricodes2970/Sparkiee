# Optional credentials & one-time setups

Everything below is optional. Sparkiee runs fully local with captions and
chirps; the chat assistant and spoken voice each need a one-time setup.

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

## Spoken voice — Piper (free, local, no account)

Sparky speaks with [Piper](https://github.com/rhasspy/piper), running
entirely on this machine:

```text
sparkiee voice setup
```

The setup is idempotent. It creates a private Python 3.11 environment under
`~/.local/share/sparkiee/tts/venv`, installs `piper-tts` from PyPI, and
downloads two voices (~60 MB each) into
`~/.local/share/sparkiee/tts/voices`:

- Hindi female: `hi_IN-priyamvada-medium`
- English female: `en_US-lessac-medium`

No API key, account, or network request is needed to **speak**; the network
is only used to install the runtime and download the models once. Verify
with `sparkiee voice status`, then listen with `sparkiee voice test`.

Voice choice and speed are stored in `~/.config/sparkiee/voice.json`
(owner-only, `0600`). `SPARKIEE_TTS_SPEED` adjusts speaking speed
(0.5–2.0).

## Chat assistant — Groq or Google AI Studio

The conversational assistant uses one of two free-tier cloud providers.
Pick one during setup:

```text
sparkiee assistant setup --provider groq
sparkiee assistant setup --provider google
```

Keys are entered through a non-echoing prompt (or supplied through
`GROQ_API_KEY` / `GOOGLE_AI_API_KEY`, with `GEMINI_API_KEY` accepted as an
alias). They are stored outside the repository in the user config directory
with `0600` permissions, verified against the provider's model list, and
never echoed, logged, embedded in the dashboard, or returned by an API.

- Groq: <https://console.groq.com/keys>
- Google AI Studio: <https://aistudio.google.com/app/apikey>

`sparkiee assistant setup --remove` forgets only the active provider's key;
the other provider is kept. `sparkiee assistant status` reports mic, STT,
chat, and TTS readiness separately and honestly.

Set **Local-only** in the dashboard, or export
`SPARKIEE_CHAT_LOCAL_ONLY=1`, to block all outbound chat requests. Music
commands are still parsed locally and never leave the machine.

## Wake word "Yo Spark" (needs external setup — honestly disabled now)

Status: `needs-setup` — requires all three, until then the push-to-talk
hotkey is the supported way to talk to Sparky:

1. `npm i picovoice/porcupine` node module (wake listener dep)
2. A Picovoice Console AccessKey (free account), stored with the same
   never-echoed `0600` file pattern as the chat keys
3. A trained keyword model: train "Yo Spark" on Picovoice Console for
   platform `linux_x86_64`, save as `sparkiee_linux.ppn`, place it under
   `~/.config/sparkiee/wake/sparkiee_linux.ppn`.

## Controls cheat sheet

- `sparkiee ptt toggle` — start/stop push-to-talk capture (bound to
  Ctrl+Alt+Space via the GNOME media-keys fallback)
- `sparkiee assistant hotkey status|install|remove`
- `sparkiee pet dock` — pin Sparky on the OpenCode chatbox; `pet undock`,
  `pet sleep`, `pet wake`, and `pet status` control the same posture
- Dashboard → assistant card: live state, last action, mic test, cancel
