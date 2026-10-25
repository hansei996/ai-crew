#!/usr/bin/env python
# tts_local.py — 用本地 WIndexTTS (IndexTTS-2.5) 给 script.json 配音
# 用法（必须用整合包自带 runtime）:
#   <WINDIFFTTS_BUNDLE>\\runtime\\python.exe bili_run\\tts_local.py episodes/exp001/script.json
import json, os, sys, subprocess, time
from pathlib import Path

BUNDLE = Path(r'<WINDIFFTTS_BUNDLE>')
WEIGHTS = BUNDLE / 'models' / 'IndexTTS-2.5'
FFPROBE = BUNDLE / 'ffmpeg' / 'bin' / 'ffprobe.exe'
FFMPEG = BUNDLE / 'ffmpeg' / 'bin' / 'ffmpeg.exe'
REF = Path(r'<WORKSPACE>\bili_run\tts\refs\ref_luke.wav')

def main():
    script_path = Path(sys.argv[1]).resolve()
    sc = json.loads(script_path.read_text(encoding='utf-8'))
    ref = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else REF
    emo_text = os.environ.get('TTS_EMO_TEXT') or None
    emo_alpha = float(os.environ.get('TTS_EMO_ALPHA', '1.0'))
    if not ref.exists():
        print(json.dumps({'ok': False, 'err': 'ref audio missing: ' + str(ref)}, ensure_ascii=False)); return 1
    import torch
    from windextts.inference import WIndexTTS
    t0 = time.perf_counter()
    tts = WIndexTTS(weights_dir=str(WEIGHTS), device='cuda', dtype=torch.float16, enable_w4a16=False)
    print(json.dumps({'stage': 'loaded', 'sec': round(time.perf_counter() - t0, 1)}), flush=True)
    voice_dir = script_path.parent / 'voice'
    voice_dir.mkdir(parents=True, exist_ok=True)
    done = []
    for i, s in enumerate(sc.get('scenes', [])):
        line = s.get('line')
        if not line: continue
        out_mp3 = voice_dir / ('s%d.mp3' % (i + 1))
        out_wav = voice_dir / ('s%d.wav' % (i + 1))
        ts = time.perf_counter()
        sr, audio = tts.infer(spk_audio_prompt=str(ref), text=line, lang='ZH', emo_text=emo_text, emo_alpha=emo_alpha)
        import soundfile as sf
        arr = audio.detach().float().cpu()
        if arr.dim() == 1:
            arr = arr.unsqueeze(0)
        sf.write(str(out_wav), arr.transpose(0, 1).numpy(), int(sr))
        subprocess.run([str(FFMPEG), '-hide_banner', '-y', '-i', str(out_wav), '-ar', '24000', '-ac', '1', '-b:a', '64k', str(out_mp3)], capture_output=True)
        probe = subprocess.run([str(FFPROBE), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(out_mp3)], capture_output=True, text=True)
        dur = float(probe.stdout.strip() or 0)
        s['durationSec'] = max(6, round((dur + 0.9) * 10) / 10)
        s['voicePath'] = 'voice/s%d.mp3' % (i + 1)
        done.append({'scene': i + 1, 'sec': round(dur, 2), 'gen_sec': round(time.perf_counter() - ts, 2)})
        print(json.dumps(done[-1], ensure_ascii=False), flush=True)
    script_path.write_text(json.dumps(sc, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'ok': True, 'scenes': len(done), 'synthesized': done}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())