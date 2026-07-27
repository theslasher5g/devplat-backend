import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function TrialEnding({ teamName, daysLeft, pricingUrl }: {
  teamName: string; daysLeft: number; pricingUrl: string;
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
        Plans start at CHF 19 a month, billed flat by how many environments you run in parallel — no per-minute metering.
      </Paragraph>
      <CtaButton href={pricingUrl}>Choose a plan</CtaButton>
      <FallbackLink href={pricingUrl} />
    </Layout>
  );
}
