'use strict';

/**
 * Specialty registry for CaseArc multi-specialty support.
 * Each entry defines: slug, display label, ACGME numeric ID,
 * Whisper vocabulary hint, and example procedure names for Claude.
 */
const SPECIALTIES = [
  {
    code: 'plastic-surgery',
    label: 'Plastic Surgery',
    acgmeId: '158',
    whisperHint: 'Plastic surgery case log. Procedures: rhinoplasty, mastopexy, abdominoplasty, augmentation mammoplasty, reduction mammaplasty, blepharoplasty, rhytidectomy, DIEP flap, TRAM flap, cleft lip, carpal tunnel release.',
    parseCaseExamples: [
      'breast augmentation implant',
      'abdominoplasty',
      'rhinoplasty primary',
      'blepharoplasty upper eyelid',
      'skin graft split thickness',
      'mastopexy',
      'carpal tunnel release',
      'DIEP flap',
    ],
  },
  {
    code: 'physical-medicine-rehabilitation',
    label: 'Physical Medicine & Rehabilitation',
    acgmeId: '79',
    whisperHint: 'Physical medicine and rehabilitation PM&R case log. Procedures: EMG, nerve conduction study, trigger point injection, large joint injection, epidural steroid injection, transforaminal epidural injection, medial branch block, radiofrequency ablation, chemodenervation, baclofen pump refill.',
    parseCaseExamples: [
      'electromyography nerve conduction study',
      'trigger point injection',
      'large joint aspiration injection',
      'epidural steroid injection lumbar',
      'transforaminal epidural injection',
      'medial branch block lumbar',
      'radiofrequency ablation lumbar facets',
      'chemodenervation extremity',
    ],
  },
  {
    code: 'general-surgery',
    label: 'General Surgery',
    acgmeId: '220',
    whisperHint: 'General surgery case log. Procedures: laparoscopic cholecystectomy, appendectomy, hernia repair, colectomy, Whipple, Hartmann, Nissen fundoplication, bowel resection.',
    parseCaseExamples: [
      'laparoscopic cholecystectomy',
      'appendectomy laparoscopic',
      'inguinal hernia repair mesh',
      'colectomy sigmoid laparoscopic',
      'small bowel resection',
      'pancreaticoduodenectomy Whipple',
      'Hartmann procedure',
    ],
  },
  {
    code: 'orthopaedic-surgery',
    label: 'Orthopaedic Surgery',
    acgmeId: '260',
    whisperHint: 'Orthopaedic surgery case log. Procedures: total knee arthroplasty, total hip arthroplasty, ACL reconstruction, rotator cuff repair, ORIF, arthroscopy, spinal fusion.',
    parseCaseExamples: [
      'total knee arthroplasty',
      'total hip arthroplasty',
      'ACL reconstruction autograft',
      'rotator cuff repair arthroscopic',
      'ORIF femur',
      'lumbar spinal fusion',
      'knee arthroscopy meniscectomy',
    ],
  },
  {
    code: 'neurosurgery',
    label: 'Neurosurgery',
    acgmeId: '250',
    whisperHint: 'Neurosurgery case log. Procedures: craniotomy, laminectomy, ventriculoperitoneal shunt, microdiscectomy, deep brain stimulation, carotid endarterectomy.',
    parseCaseExamples: [
      'craniotomy tumor resection',
      'lumbar microdiscectomy',
      'ventriculoperitoneal shunt placement',
      'laminectomy decompression',
      'deep brain stimulation',
      'carotid endarterectomy',
    ],
  },
  {
    code: 'otolaryngology',
    label: 'Otolaryngology',
    acgmeId: '280',
    whisperHint: 'ENT otolaryngology case log. Procedures: tonsillectomy, adenoidectomy, tympanoplasty, functional endoscopic sinus surgery, parotidectomy, thyroidectomy, septoplasty.',
    parseCaseExamples: [
      'tonsillectomy adenoidectomy',
      'functional endoscopic sinus surgery',
      'tympanoplasty',
      'parotidectomy superficial',
      'thyroidectomy total',
      'septoplasty',
    ],
  },
  {
    code: 'urology',
    label: 'Urology',
    acgmeId: '420',
    whisperHint: 'Urology case log. Procedures: radical prostatectomy, nephrectomy, cystoscopy, TURP, ureteroscopy, pyeloplasty, radical cystectomy.',
    parseCaseExamples: [
      'radical prostatectomy laparoscopic',
      'nephrectomy partial',
      'cystoscopy with biopsy',
      'transurethral resection prostate',
      'ureteroscopy laser lithotripsy',
      'pyeloplasty',
    ],
  },
  {
    code: 'vascular-surgery',
    label: 'Vascular Surgery',
    acgmeId: '440',
    whisperHint: 'Vascular surgery case log. Procedures: aortobifemoral bypass, carotid endarterectomy, endovascular aortic repair EVAR, AV fistula, femoropopliteal bypass, thrombectomy.',
    parseCaseExamples: [
      'carotid endarterectomy',
      'endovascular aortic repair EVAR',
      'femoropopliteal bypass',
      'AV fistula creation',
      'arterial thrombectomy',
      'aortobifemoral bypass',
    ],
  },
];

/** Numeric ACGME ID → specialty slug */
const ACGME_ID_TO_SLUG = {};
SPECIALTIES.forEach(s => { ACGME_ID_TO_SLUG[s.acgmeId] = s.code; });

/**
 * Look up a specialty entry by slug.
 * Returns the plastic-surgery entry as fallback (never returns undefined).
 */
function getSpecialty(slug) {
  return SPECIALTIES.find(s => s.code === slug) || SPECIALTIES[0];
}

module.exports = { SPECIALTIES, ACGME_ID_TO_SLUG, getSpecialty };
