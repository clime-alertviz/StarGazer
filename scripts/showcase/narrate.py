#!/usr/bin/env python3
"""Synthesize the film's original narration with a local Piper voice."""
import argparse
import json
import wave
from pathlib import Path
from piper import PiperVoice, SynthesisConfig

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--model', type=Path, required=True)
args = parser.parse_args()
voice = PiperVoice.load(str(args.model))
directory = ROOT / 'output/showcase-2026/narration'
directory.mkdir(parents=True, exist_ok=True)
for scene in json.loads((Path(__file__).with_name('storyboard.json')).read_text()):
    path = directory / (scene['id'] + '.wav')
    with wave.open(str(path), 'wb') as output:
        voice.synthesize_wav(scene['voice'], output,
                             syn_config=SynthesisConfig(length_scale=0.96, noise_scale=0.55, noise_w_scale=0.7))
    with wave.open(str(path)) as audio:
        seconds = audio.getnframes() / audio.getframerate()
    print(f'{scene["id"]}: {seconds:.2f}s for {scene["duration"]}s scene', flush=True)
