import { describe, it, expect } from 'vitest';
import { compactMetar, compactTaf, compactSigmets, parsePirepCsv } from '../scripts/build-aviation.mjs';

describe('compactado para la app', () => {
  it('METAR', () => {
    const m = { icaoId: 'LEPA', obsTime: 1790247600, temp: 27, wdir: 230, wspd: 8, visib: '6+', rawOb: 'METAR LEPA 241100Z …', clouds: [{ cover: 'FEW', base: 1800 }], fltCat: 'VFR' };
    expect(compactMetar(m)).toEqual({ raw: 'METAR LEPA 241100Z …', t: 1790247600000, wdir: 230, wspd: 8, wgst: null, visib: '6+', clouds: [{ cover: 'FEW', base: 1800 }], wx: '', temp: 27, fltCat: 'VFR' });
  });
  it('TAF', () => {
    const t = { rawTAF: 'TAF LEMD …', issueTime: '2026-09-24T11:00:00.000Z', fcsts: [{ timeFrom: 1, timeTo: 2, fcstChange: 'TEMPO', probability: 40, wspd: 8, wgst: 18, visib: '6+', wxString: null }] };
    expect(compactTaf(t)).toEqual({ raw: 'TAF LEMD …', issue: Date.parse('2026-09-24T11:00:00.000Z'), fcsts: [{ from: 1, to: 2, change: 'TEMPO', prob: 40, wspd: 8, wgst: 18, visib: '6+', wx: '' }] });
  });
  it('SIGMET: solo turbulencia, tormentas, onda de montaña y ciclones', () => {
    const s = { hazard: 'TS', qualifier: 'EMBD', base: null, top: 52000, validTimeFrom: 1, validTimeTo: 2, coords: [{ lat: 1, lon: 2 }], rawSigmet: 'raw', firName: 'NADI' };
    expect(compactSigmets([s, { ...s, hazard: 'ICE' }, { ...s, hazard: 'VA' }])).toEqual([
      { hazard: 'TS', qualifier: 'EMBD', base: null, top: 52000, validFrom: 1, validTo: 2, coords: [{ lat: 1, lon: 2 }], raw: 'raw', fir: 'NADI' },
    ]);
  });
  it('PIREP desde el CSV de caché: solo con dato de turbulencia y en Europa/Atlántico', () => {
    const header = 'receipt_time,observation_time,mid_point_assumed,no_time_stamp,flt_lvl_range,above_ground_level_indicated,no_flt_lvl,bad_location,aircraft_ref,latitude,longitude,altitude_ft_msl,sky_cover,cloud_base_ft_msl,cloud_top_ft_msl,sky_cover,cloud_base_ft_msl,cloud_top_ft_msl,turbulence_type,turbulence_intensity,turbulence_base_ft_msl,turbulence_top_ft_msl,turbulence_freq,turbulence_type,turbulence_intensity,turbulence_base_ft_msl,turbulence_top_ft_msl,turbulence_freq,icing_type,icing_intensity,icing_base_ft_msl,icing_top_ft_msl,icing_type,icing_intensity,icing_base_ft_msl,icing_top_ft_msl,visibility_statute_mi,wx_string,temp_c,wind_dir_degrees,wind_speed_kt,vert_gust_kt,report_type,raw_text';
    const row = (lat, lon, tt, ti, raw) => ['2026-09-24T11:21:03Z', '2026-09-24T11:08:00.000Z', '', '', '', '', '', '', 'X', lat, lon, '36000', '', '', '', '', '', '', tt, ti, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '224', '106', '', 'AIREP', raw].join(',');
    const csv = ['No errors', 'No warnings', '1 ms', 'data source=aircraftreports', '3 results', header,
      row('58.0000', '-10.0000', 'CHOP', 'LGT', 'ARP A TB LGT'),
      row('56.1', '-17.85', '', '', 'sin turbulencia informada'),
      row('35.0', '-100.0', 'CAT', 'MOD', 'EEUU')].join('\n');
    expect(parsePirepCsv(csv)).toEqual([{ lat: 58, lon: -10, fl: 360, t: Date.parse('2026-09-24T11:08:00.000Z'), int: 'LGT', type: 'CHOP', raw: 'ARP A TB LGT' }]);
  });
});
