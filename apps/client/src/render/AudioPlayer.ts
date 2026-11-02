import * as THREE from "three";

/**
 * 素材の音を鳴らす。位置があれば立体音響（PositionalAudio）、なければ聞いている人の位置で鳴らす。
 * 音声データは素材 ID（中身のハッシュ）ごとに 1 回だけ読み込む。
 */
export class AudioPlayer {
  private readonly listener = new THREE.AudioListener();
  private readonly loader = new THREE.AudioLoader();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly playing = new Set<THREE.Audio | THREE.PositionalAudio>();

  constructor(
    private readonly scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    camera.add(this.listener);
  }

  play(asset: string, position: [number, number, number] | null, volume: number): void {
    // ブラウザは操作のあとでないと音を出さないので、止まっていたら再開を試みる
    if (this.listener.context.state === "suspended") void this.listener.context.resume();
    let buffer = this.buffers.get(asset);
    if (!buffer) {
      buffer = this.loader.loadAsync(`/api/assets/${asset}`);
      this.buffers.set(asset, buffer);
    }
    buffer
      .then((b) => {
        const sound = position
          ? new THREE.PositionalAudio(this.listener)
          : new THREE.Audio(this.listener);
        sound.setBuffer(b);
        sound.setVolume(Math.max(0, Math.min(volume, 2)));
        if (position && sound instanceof THREE.PositionalAudio) {
          sound.setRefDistance(2);
          sound.position.set(...position);
          this.scene.add(sound);
        }
        sound.onEnded = () => {
          sound.removeFromParent();
          this.playing.delete(sound);
        };
        this.playing.add(sound);
        sound.play();
      })
      .catch(() => this.buffers.delete(asset));
  }

  dispose(): void {
    for (const s of this.playing) {
      if (s.isPlaying) s.stop();
      s.removeFromParent();
    }
    this.playing.clear();
    this.listener.removeFromParent();
  }
}
