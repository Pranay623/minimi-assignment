import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('walkthrough streams, exposes sources, persists, and deletes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good questions deserve/ })).toBeVisible();
  await page.getByRole('button', { name: /See the whole story/ }).click();
  await expect(page.getByText('Sample conversation', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Compare Postgres pricing' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('HarborDB is still the cheapest verified option')).toBeVisible();
  await page.getByRole('button', { name: 'Open source S2: HarborDB · new price example' }).click();
  await expect(page.getByRole('heading', { name: 'Sources & evidence' })).toBeVisible();
  await expect(page.getByText('Fictional: monthly plan $24, effective November 6.')).toBeVisible();
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await page.reload();
  await page
    .getByRole('button', { name: /A week of decisions/ })
    .first()
    .click();
  await expect(page.getByText('HarborDB is still the cheapest verified option')).toBeVisible();
  await page.getByRole('button', { name: 'Delete A week of decisions' }).click();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good questions deserve/ })).toBeVisible();
});

test('live chat explains missing configuration', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Hello');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/Add your .+ and Tavily keys/)).toBeVisible();
});

test('home and setup pass automated WCAG A/AA checks', async ({ page }) => {
  await page.goto('/');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Connection settings' }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('can stop streaming and retry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /See the whole story/ }).click();
  await page.getByRole('button', { name: 'Recheck our CRM shortlist' }).click();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByText('You stopped this response.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('mobile layout fits the viewport and navigation works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good questions deserve/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /See the whole story/ }).click();
  await expect(page.getByRole('button', { name: 'Compare Postgres pricing' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your message' }).fill('Tell me more');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('scripted walkthrough', { exact: false }).last()).toBeVisible({
    timeout: 15000,
  });
});
