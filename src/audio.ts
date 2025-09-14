export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private current: { gain: GainNode; osc: OscillatorNode; filter: BiquadFilterNode } | null = null

  private getContext(): AudioContext {
    if (!this.ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext
      this.ctx = new AC()
    }
    const ctx = this.ctx!
    if (!this.master) {
      this.master = ctx.createGain()
      this.master.gain.value = 0.9
      this.master.connect(ctx.destination)
    }
    return ctx
  }

  ensure() {
    const ctx = this.getContext()
    if (ctx.state === 'suspended') ctx.resume()
  }

  private midiToHz(midi: number) {
    return 440 * Math.pow(2, (midi - 69) / 12)
  }

  stopCurrent(fadeMs = 40) {
    if (!this.current || !this.ctx) return
    const now = this.ctx.currentTime
    try {
      this.current.gain.gain.cancelScheduledValues(now)
      this.current.gain.gain.setTargetAtTime(0, now, Math.max(0.001, fadeMs / 1000))
    } catch {}
    try { this.current.osc.stop(now + Math.max(0.02, fadeMs / 1000 + 0.01)) } catch {}
    this.current = null
  }

  playMidi(midi: number) {
    const ctx = this.getContext()
    if (ctx.state === 'suspended') ctx.resume()

    // stop anything sounding
    this.stopCurrent(40)

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = this.midiToHz(midi)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1800
    filter.Q.value = 0.6

    const gain = ctx.createGain()
    gain.gain.value = 0

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.master!)

    const now = ctx.currentTime
    // Simple pluck envelope
    const attack = 0.005
    const decay = 0.12
    const sustain = 0.0
    const release = 0.4

    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.9, now + attack)
    gain.gain.linearRampToValueAtTime(sustain, now + attack + decay)

    osc.start(now)
    // schedule stop (will also be cut if another note triggers)
    osc.stop(now + attack + decay + release + 0.4)

    this.current = { gain, osc, filter }
  }
}

export const audio = new AudioEngine()
