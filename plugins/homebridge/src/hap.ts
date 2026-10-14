import hapModule from 'hap-nodejs';

/** The hap-nodejs instance shared by Livynq and every Homebridge plugin it loads (api.hap). */
export const hap = hapModule;
export type Hap = typeof hapModule;
