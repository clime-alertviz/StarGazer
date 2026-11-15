# Look up, together

[Watch the walkthrough](showcase.mp4) · [English captions](showcase.en.srt)
· [Written tutorial](walkthrough.md) · [Original soundtrack](showcase-music.mp3)

A **68.5-second**, 1080p walkthrough of the current StarGazer web app. Mia starts
setting up an evening, discovers a night she could join, checks the sky and her
journey, joins the group and invites someone into her circle. The ending shows
the option to organize an evening of her own.

English voiceover, readable captions, animated stars, an original musical score
and gentle interface sounds keep the presentation focused on the experience.

## Credits

- Project: Michal Novotný · StarGazer 0.4.0.
- Places and journeys: [Geoapify](https://www.geoapify.com/).
- Music and effects: **Little Constellations**, an original procedural composition
  and synthesis created for this project, with no third-party music samples.
- English synthetic narration: Piper `en_US-ljspeech-high`. The model is not
  bundled; its [model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD)
  identifies the training dataset as public domain.
- App graphics, screenplay and editing: created for StarGazer.

Captured from the current interface on 16 November 2026 using the sample
community. The edit uses selected screen captures, gentle camera motion and
shortcuts between steps. It shows the product workflow, not an installation lesson.
Technical setup and live-data checks are in the written documentation.

## Files

- `showcase.mp4`: H.264, 1920 × 1080, 30 fps, stereo AAC; optimized for web playback.
- `showcase-poster.jpg`: preview image.
- `showcase.en.srt` / `showcase.en.vtt`: English captions; also burned into the video.
- `showcase-music.mp3`: original score on its own.

## Edit or regenerate

The scene script is [storyboard.json](../scripts/showcase/storyboard.json).
[narrate.py](../scripts/showcase/narrate.py) generates narration and
[render.py](../scripts/showcase/render.py) mixes the score, effects, captions and
video. Working captures and WAV files are in ignored `output/showcase-2026/`.
A fresh checkout includes the finished film; re-editing needs those captures and
the matching Piper model/configuration files.

```bash
python3 -m venv output/video-env
output/video-env/bin/pip install Pillow numpy scipy piper-tts
output/video-env/bin/python scripts/showcase/narrate.py --model /path/to/en_US-ljspeech-high.onnx
output/video-env/bin/python scripts/showcase/render.py --preview
output/video-env/bin/python scripts/showcase/render.py
```

The renderer requires FFmpeg and the Inter/DejaVu fonts (`fonts-inter` and
`fonts-dejavu-core` on Debian/Ubuntu). Adjust its font paths on other platforms.
The finished video, original score and project-authored material are distributed
with this repository under its [MIT license](../LICENSE); dependency/model
licenses remain their own.
