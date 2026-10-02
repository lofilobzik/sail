export { buildBoat, type BoatModel } from './boat';
export {
  defaultConfig,
  withDisabledLayers,
  LAYER_IDS,
  type EnvironmentConfig,
  type LayerId,
  type ModelOptions,
  type SimConfig,
  type TermToggles,
} from './config';
export { FixedStep } from './fixedStep';
export * from './frames';
export { CubicSpline } from './spline';
export { initialState, NEUTRAL_CONTROLS, type BoatState, type Controls } from './state';
export { evaluate, step, type Diagnostics, type StepResult } from './step';
export { getWind } from './wind';
export { delftUpright } from './layers/hull';
export {
  defaultWaves, setWaveParameters, setWaveWind, setWaveLayers, waveAmplitude,
  createWaveSample, sampleWaveParticle, sampleWaves,
  gerstnerGLSL, WAVE_PARAMETERS, type WaveConfig, type WaveSample, type WaveComponent,
} from './waves';
