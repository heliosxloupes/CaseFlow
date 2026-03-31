const fs = require('fs');
const path = require('path');
const { chromium } = require('../acgme-backend/node_modules/playwright');

const APP_URL = 'https://case-flow-sage.vercel.app';
const OUT_DIR = 'C:\\Users\\IVIso\\OneDrive\\Desktop\\StitchImport';

const sampleCases = Array.from({ length: 88 }, (_, i) => ({
  id: `case-${i + 1}`,
  date: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
  procs: i === 0
    ? [
        {
          c: '11042',
          d: 'Debridement, subcutaneous tissue (includes epidermis and dermis, if performed); first 20 sq cm or less',
          a: 'Wounds Or Deformities Of Trunk',
        },
      ]
    : [
        {
          c: String(19318 + (i % 6)),
          d: i % 2 ? 'Breast reduction' : 'Breast reconstruction with implant',
          a: i % 2 ? 'Breast Macromastia' : 'Absent Breast',
        },
      ],
  role: i % 3 === 0 ? 'Surgeon' : 'Assistant',
  site: 'Dr Dan Plastic Surgery, PLLC',
  att: 'Amjad, Ibrahim',
  pt: i % 4 === 0 ? 'Pediatric' : 'Adult',
  yr: '4',
  caseId: i === 0 ? 'CF-10318' : '',
  cid: i === 0 ? 'CF-10318' : '',
  status: i % 5 === 0 ? 'pending' : 'submitted',
  ts: new Date(`2026-03-${String((i % 28) + 1).padStart(2, '0')}T16:30:00Z`).toISOString(),
}));

const sampleMilestones = {
  residentName: 'Iakov Efimenko',
  reportTitle: 'Integrated-Plastic Surgery Minimum',
  specialtyCode: '3621100001',
  sourceAsOf: '3/31/2026',
  generatedAt: '2026-03-31T20:37:00.000Z',
  sourceFormat: 'EXCEL',
  summary: {
    overallCompletionPct: 100,
    totalCompleted: 2205,
    totalMinimum: 1593,
    totalRemaining: 123,
    completeCategories: 39,
    incompleteCategories: 22,
    atRiskCategories: 13,
  },
  categories: [
    { categoryName: 'Breast reconstruction with implant', section: 'Absent Breast', completed: 3, minimumRequired: 30, remaining: 27, completionPct: 10, status: 'at-risk' },
    { categoryName: 'Burn reconstruction', section: 'Integument Burns', completed: 2, minimumRequired: 16, remaining: 14, completionPct: 13, status: 'at-risk' },
    { categoryName: 'Primary cleft lip repair', section: 'Cleft Lip', completed: 1, minimumRequired: 7, remaining: 6, completionPct: 14, status: 'at-risk' },
    { categoryName: 'Breast reduction', section: 'Breast Macromastia', completed: 15, minimumRequired: 24, remaining: 9, completionPct: 63, status: 'in-progress' },
    { categoryName: 'Treat wounds of trunk with flap', section: 'Wounds Or Deformities Of Trunk', completed: 8, minimumRequired: 15, remaining: 7, completionPct: 53, status: 'in-progress' },
    { categoryName: 'Excision of soft tissue lesion', section: 'Soft Tissue', completed: 6, minimumRequired: 10, remaining: 4, completionPct: 60, status: 'in-progress' },
    { categoryName: 'Rhinoplasty', section: 'Nose', completed: 12, minimumRequired: 12, remaining: 0, completionPct: 100, status: 'complete' },
    { categoryName: 'Hand fracture fixation', section: 'Hand', completed: 14, minimumRequired: 12, remaining: 0, completionPct: 100, status: 'complete' },
  ],
};

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bootstrapLoggedIn(page) {
  await page.evaluate(({ cases, milestones }) => {
    localStorage.setItem('cf5-name', 'iakov');
    localStorage.setItem('cf5-email', 'iakov@larkinhospital.com');
    localStorage.setItem('cf5-vault', JSON.stringify({ saved: true }));
    localStorage.setItem('cf5-sites', JSON.stringify(['Dr Dan Plastic Surgery, PLLC', 'Larkin Community Hospital']));
    localStorage.setItem('cf5-attendings', JSON.stringify(['Amjad, Ibrahim', 'Smith, Daniel']));
    localStorage.setItem('cf5-cases', JSON.stringify(cases));

    window.cases = cases.slice();
    milestonesState.data = milestones;
    milestonesState.loading = false;
    milestonesState.latestChecked = true;
    milestonesState.sort = 'deficiency';
    milestonesState.filter = 'incomplete';
    milestonesState.stage = 0;
    milestonesState.error = '';
    milestonesState.showAllDeficient = false;

    showPage('pg-app');
    ensureBackgroundRenderers();
    try { startOrb(); } catch (_) {}
    try { initPointerBindings(); } catch (_) {}
    resetFlow();
    document.getElementById('hdr-n').textContent = String(cases.length);
    const menuName = document.getElementById('sm-hdr-u');
    if (menuName) menuName.textContent = 'iakov';
    if (typeof SM !== 'undefined') SM.setActive('log');
    goTab('log');
  }, { cases: sampleCases, milestones: sampleMilestones });

  await sleep(900);
}

async function capture(page, name, configure) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.setViewportSize({ width: 430, height: 932 });
  await sleep(900);
  if (configure) await configure();
  await sleep(950);
  await page.screenshot({
    path: path.join(OUT_DIR, name),
    fullPage: true,
  });
}

async function main() {
  ensureOutDir();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  await capture(page, '01-login.png');

  await capture(page, '02-login-signin.png', async () => {
    await page.evaluate(() => expandAuthPanel('signin'));
  });

  await capture(page, '03-home.png', async () => {
    await bootstrapLoggedIn(page);
  });

  await capture(page, '04-menu.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => SM.open());
    await sleep(900);
  });

  await capture(page, '05-cpt-review.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      caseData.procedures = [
        {
          c: '11042',
          d: 'Debridement, subcutaneous tissue (includes epidermis and dermis, if performed); first 20 sq cm or less',
          a: 'Wounds Or Deformities Of Trunk',
        },
      ];
      showCptFound(caseData.procedures);
    });
  });

  await capture(page, '06-summary-submit.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      caseData.date = '2026-03-31';
      caseData.role = 'Surgeon';
      caseData.site = 'Dr Dan Plastic Surgery, PLLC';
      caseData.attending = 'Amjad, Ibrahim';
      caseData.patientType = 'Adult';
      caseData.caseYear = 'Year 4';
      caseData.caseId = 'CF-10318';
      caseData.procedures = [
        {
          c: '11042',
          d: 'Debridement, subcutaneous tissue (includes epidermis and dermis, if performed); first 20 sq cm or less',
          a: 'Wounds Or Deformities Of Trunk',
        },
      ];
      showCptFound(caseData.procedures);
      showSummary();
    });
    await sleep(350);
  });

  await capture(page, '07-history.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => goTab('history'));
  });

  await capture(page, '08-settings.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      goTab('settings');
      loadSettingsUI();
    });
  });

  await capture(page, '09-milestones.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      goTab('milestones');
      milestonesState.latestChecked = true;
      milestonesState.showAllDeficient = false;
      renderMilestonesPane();
    });
  });

  await capture(page, '10-submit-success.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      const overlay = document.getElementById('submit-overlay');
      resetSubmitOverlayUI();
      document.body.classList.add('submit-active');
      overlay.classList.add('on', 'success-show');
      document.getElementById('submit-kicker').textContent = 'CaseFlow Submission';
      document.getElementById('submit-label').textContent = 'Submitting to ACGME...';
      document.getElementById('submit-success-title').textContent = 'Captured in ACGME';
      document.getElementById('submit-success-sub').textContent = 'Your case has been captured in ACGME.';
    });
  });

  await capture(page, '11-edit-case.png', async () => {
    await bootstrapLoggedIn(page);
    await page.evaluate(() => {
      goTab('history');
      renderHistory();
      openCaseEdit('case-1');
    });
  });

  fs.writeFileSync(
    path.join(OUT_DIR, 'README.txt'),
    [
      'CaseFlow Stitch Import Screens',
      `Captured from: ${APP_URL}`,
      '',
      '01-login.png',
      '02-login-signin.png',
      '03-home.png',
      '04-menu.png',
      '05-cpt-review.png',
      '06-summary-submit.png',
      '07-history.png',
      '08-settings.png',
      '09-milestones.png',
      '10-submit-success.png',
      '11-edit-case.png',
      '',
      `Generated: ${new Date().toISOString()}`,
    ].join('\n')
  );

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
