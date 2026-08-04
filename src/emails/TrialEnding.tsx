import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function TrialEnding({ teamName, daysLeft, pricingUrl, entryChf, includedSeats, seatChf }: {
  teamName: string; daysLeft: number; pricingUrl: string;
  /** The cheapest purchasable plan's base price, its seat allowance, and what a
   *  further developer costs. Passed in rather than written into the copy: this
   *  paragraph said "from CHF 19" for weeks after the entry price became CHF
   *  190, in an email sent to every trialling team. A wrong number in outbound
   *  mail cannot be corrected by editing a page. */
  entryChf: number; includedSeats: number; seatChf: number;
}) {
  const ended = daysLeft <= 0;
  return (
    <Layout preview={ended ? `The trial for ${teamName} has ended` : `${daysLeft} days left on your devplat trial`}>
      <Eyebrow>Trial</Eyebrow>
      <Heading>
        {ended
          ? 'Your trial has ended.'
          : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left on your trial.`}
      </Heading>
      <Paragraph>
        {ended
          ? <>The free trial for <strong>{teamName}</strong> is over, so new environments can no longer start. Your account, tokens and settings are all still here — picking a plan brings everything straight back.</>
          : <>The free trial for <strong>{teamName}</strong> ends soon. When it does, new test environments stop starting, which usually shows up as a failing CI pipeline.</>}
      </Paragraph>
      <Paragraph>
        Plans start at CHF {entryChf} a month for {includedSeats} developers
        {seatChf > 0 ? <>, then CHF {seatChf} for each one after that</> : null}. Priced per team,
        never per minute — no metering, no overage bills.
      </Paragraph>
      <CtaButton href={pricingUrl}>Choose a plan</CtaButton>
      <FallbackLink href={pricingUrl} />
    </Layout>
  );
}
