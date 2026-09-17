import { describe, expect, it } from 'bun:test'
import {
  cleanEmailBody,
  htmlIsPlainText,
  htmlToText,
  joinWrappedLines,
  prettyUrl,
  renderRichText,
  unwrapTrackingUrl,
} from './mailText'

/* The body below is the shape that prompted this: a mail-merge plain-text part
 * with markdown emphasis, a "<https://…>" autolink wrapper around a 300
 * character appspot redirect, and lines hard-wrapped mid-sentence. */
const MERGE_BODY = `Hi Sashank Singh, I'm from Crossing Hurdles, a global recruitment firm.

*About Micro1:*

Micro1 connects domain experts with leading AI labs to help train and
improve frontier AI models using real-world expertise.

*Application Process (Takes 20 min):*

- Participate in resume evaluation & interview stage

*Apply asap (reviewed on a rolling basis):*

Competitive Coder
<https://anjali_juneja_crossinghurdles_com-dot-mmemails3.appspot.com/em_tecAMZcKsXdoENutZNzD?url=https%3A%2F%2Fjobs.micro1.ai%2Fpost%2Fdcd53728-6fe1-4c86-b362-31cdc7428e3a%3FreferralCode%3D463495f6-7cc6-49ed-8e8f-5ef2a1cc3fd7%26utm_source%3Dreferral%26utm_medium%3Dshare&kev=62e42aa6d83b9692ce661e7a98224b7>`

describe('renderRichText', () => {
  const html = renderRichText(MERGE_BODY)

  it('lifts single-asterisk emphasis instead of showing the asterisks', () => {
    expect(html).toContain('<em>About Micro1:</em>')
    expect(html).toContain('<em>Application Process (Takes 20 min):</em>')
    expect(html).not.toContain('*About')
    expect(html).not.toContain('*Apply')
  })

  it('renders bullets and keeps entities intact', () => {
    expect(html).toContain('<li>Participate in resume evaluation &amp; interview stage</li>')
  })

  it('turns the autolink wrapper into the real destination, not the tracker', () => {
    expect(html).not.toContain('appspot.com')
    expect(html).not.toContain('&lt;https')
    expect(html).toContain('href="https://jobs.micro1.ai/post/dcd53728-6fe1-4c86-b362-31cdc7428e3a?referralCode=')
    expect(html).toContain('>jobs.micro1.ai/')
  })

  it('rejoins hard-wrapped lines into whole paragraphs', () => {
    expect(html).toContain('to help train and improve frontier AI models using real-world expertise.')
  })

  it('keeps deliberate short lines apart', () => {
    const out = renderRichText('88 Stevenson St\nSan Francisco, CA 94105')
    expect(out.match(/rt-p/g)).toHaveLength(2)
    const sig = renderRichText('Thanks,\nAnjali')
    expect(sig.match(/rt-p/g)).toHaveLength(2)
  })

  it('keeps markdown links and plain URLs', () => {
    expect(renderRichText('see [the post](https://x.com/a/b)')).toContain('href="https://x.com/a/b"')
    expect(renderRichText('see https://x.com/a/b for more')).toContain('>x.com/a/b</a>')
  })

  it('still trims reply chains and dims quotes', () => {
    const out = renderRichText('Sounds good.\n\nOn Tue, Sep 16 Amy wrote:\n> old text\nmore old')
    expect(out).toContain('Sounds good.')
    expect(out).not.toContain('old text')
    const quoted = renderRichText('Yes.\n> earlier line')
    expect(quoted).toContain('<p class="emq">earlier line</p>')
  })
})

describe('joinWrappedLines', () => {
  it('joins a list item continuation', () => {
    const merged = joinWrappedLines([
      '• Stay updated with evolving competitive programming standards and',
      'incorporate best practices into checker development.',
    ])
    expect(merged).toEqual(['• Stay updated with evolving competitive programming standards and incorporate best practices into checker development.'])
  })

  it('does not join across a blank line or into a quote', () => {
    expect(joinWrappedLines(['One', '', 'Two'])).toEqual(['One', '', 'Two'])
    expect(joinWrappedLines(['> quoted long line that runs on and on and on past the wrap width', 'next'])).toEqual([
      '> quoted long line that runs on and on and on past the wrap width',
      'next',
    ])
  })
})

describe('tracking URLs', () => {
  const tracker =
    'https://x-dot-mmemails3.appspot.com/em_abc?url=https%3A%2F%2Fjobs.micro1.ai%2Fpost%2F1%3Futm_source%3Dreferral&kev=abc'

  it('unwraps the destination', () => {
    expect(unwrapTrackingUrl(tracker)).toBe('https://jobs.micro1.ai/post/1?utm_source=referral')
  })

  it('leaves a plain URL alone', () => {
    expect(unwrapTrackingUrl('https://jobs.micro1.ai/post/1')).toBe('https://jobs.micro1.ai/post/1')
  })

  it('shows a short label for a long link', () => {
    expect(prettyUrl('https://jobs.micro1.ai/post/dcd53728-6fe1-4c86-b362-31cdc7428e3a')).toBe(
      'jobs.micro1.ai/…/dcd53728-6fe1-4c86-…',
    )
    expect(prettyUrl('https://luma.com/oss4ai-21xr?pk=g-bdlc0DW9WWBHWLJ')).toBe('luma.com/oss4ai-21xr?pk=g-bdlc0DW9WWBHWLJ')
  })
})

describe('cleanEmailBody', () => {
  it('drops cid refs and decodes entities', () => {
    expect(cleanEmailBody('a [cid:image001.png] b &amp; c')).toBe('a  b & c')
  })
})

describe('html bodies that are really text', () => {
  it('flags a naked text blob and converts it back', () => {
    const html = '<div>*About Micro1:*\nCompetitive Coder &lt;https://x.com/a&gt;</div>'
    expect(htmlIsPlainText(html)).toBe(true)
    const text = htmlToText(html)
    expect(renderRichText(text)).toContain('<em>About Micro1:</em>')
    expect(renderRichText(text)).toContain('>x.com/a</a>')
  })

  it('leaves real HTML alone', () => {
    expect(htmlIsPlainText('<p>Hello</p><a href="https://x.com">x</a>')).toBe(false)
  })
})
