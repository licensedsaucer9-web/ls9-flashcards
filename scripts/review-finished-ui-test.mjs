import assert from 'node:assert/strict'

// Run within the existing account UI harness, with real IndexedDB and no live services.
export async function testReviewFinishedUI(newPage) {
  for (const { size, due } of [{ size: 3, due: 7 }, { size: 20, due: 2 }, { size: 0, due: 2 }]) {
    const page = await newPage()
    await page.click('#guest-study')
    await page.waitForSelector('#start')
    await page.evaluate(async ({ size, due }) => {
      const db = await import('/src/db.ts')
      const cards = await db.getAllCards()
      const future = Date.now() + 86400000
      await db.putCards(cards.map((card, i) => ({
        ...card, tier: i < 7 ? 1 : 2, tags: ['verb'], article: 'none',
        srs: { ...card.srs, due: i < due ? 0 : future },
      })))
      await db.putSettings({ tier: 1, selectedTiers: [1], wordTypes: ['verb'], sessionSize: size })
    }, { size, due })
    await page.reload()
    await page.waitForSelector('#start')
    await page.click('#start')
    const finish = async count => {
      for (let remaining = count; remaining > 0; remaining--) {
        await page.waitForFunction(n => document.querySelector('[data-remaining]')?.textContent === String(n), remaining)
        await page.click('#card')
        await page.click('[data-grade="good"]')
      }
      await page.waitForSelector('#review-more')
    }
    const firstCount = size ? Math.min(size, due) : due
    await finish(firstCount)
    assert.equal(await page.locator('#home').textContent(), 'Home')
    assert.equal(await page.locator('#review-more').textContent(), `${size || 'All'} more`)
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 })
      const home = await page.locator('#home').boundingBox()
      const more = await page.locator('#review-more').boundingBox()
      assert.equal(home.y, more.y, 'finished actions share a row')
      assert.equal(home.width, more.width, 'finished actions have equal width')
      assert.equal(home.height, more.height, 'finished actions have equal height')
      assert(home.x >= 0 && more.x + more.width <= width, 'both actions fit the viewport')
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
      if (size === 3 && width === 320) await page.screenshot({ path: '/tmp/issue-103-review-finished-mobile.png' })
    }
    if (size === 3) {
      await page.locator('#review-more').tap()
    } else {
      // Enter must activate the button rather than be swallowed by review shortcuts.
      await page.locator('#review-more').focus()
      await page.keyboard.press('Enter')
    }
    const remainingDue = due - firstCount
    const nextCount = size ? Math.min(size, remainingDue || 7) : (remainingDue || 7)
    await page.waitForFunction(n => document.querySelector('[data-remaining]')?.textContent === String(n), nextCount)
    assert.equal(await page.evaluate(() => location.hash), '#/review', 'restart stays in Review')
    assert.equal(await page.locator('#start').count(), 0, 'restart immediately opens cards')
    assert.equal(await page.locator('.review-meta').textContent().then(text => text.includes('Review ahead')), !remainingDue)
    await finish(nextCount)
    await page.click('#home')
    await page.waitForSelector('#start')
    assert.equal(await page.evaluate(async () => (await (await import('/src/db.ts')).getSettings()).sessionSize), size)
    await page.context().close()
  }
}
