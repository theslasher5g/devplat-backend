import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

/**
 * Tells a team owner their pipelines are queueing behind their own parallelism
 * limit. Deliberately written as an observation with numbers attached rather
 * than a sales pitch: the recipient is already paying, and the only thing that
 * makes this mail welcome instead of irritating is that it reports something
 * true they could not otherwise see.
 */
export default function CapacityLimit({
  teamName, blockedRuns, windowDays, waitText, currentLimit, upgradeLabel, upgradeParallel, upgradeChf, billingUrl,
}: {
  teamName: string; blockedRuns: number; windowDays: number; waitText: string | null;
  currentLimit: number; upgradeLabel: string | null; upgradeParallel: number | null;
  upgradeChf: number | null; billingUrl: string;
}) {
  return (
    <Layout preview={`${blockedRuns} runs waited for a free environment in the last ${windowDays} days`}>
      <Eyebrow>Usage</Eyebrow>
      <Heading>Your test runs are queueing.</Heading>
      <Paragraph>
        In the last {windowDays} days, <strong>{blockedRuns} run{blockedRuns === 1 ? '' : 's'}</strong> for{' '}
        <strong>{teamName}</strong> had to wait for a free environment — all {currentLimit} of your parallel
        environment{currentLimit === 1 ? ' was' : 's were'} already busy when they started.
        {waitText ? <> That added up to <strong>{waitText}</strong> of waiting.</> : null}
      </Paragraph>
      <Paragraph>
        Nothing failed and nothing was lost: queued runs start automatically as soon as a slot frees up. It just
        means your pipelines finish later than they could.
      </Paragraph>
      {upgradeLabel && upgradeParallel ? (
        <>
          <Paragraph>
            {upgradeLabel} runs {upgradeParallel} environments in parallel for CHF {upgradeChf} a month. If the
            waiting is costing you more than the difference, it is worth the change — and if this was one unusual
            week, ignore this and it will not come back unless it happens again.
          </Paragraph>
          <CtaButton href={billingUrl}>Review your plan</CtaButton>
          <FallbackLink href={billingUrl} />
        </>
      ) : (
        <>
          <Paragraph>
            You are already on the largest plan. If this is a regular pattern, reply to this mail — more parallel
            capacity is something we can arrange directly.
          </Paragraph>
          <CtaButton href={billingUrl}>See your usage</CtaButton>
          <FallbackLink href={billingUrl} />
        </>
      )}
    </Layout>
  );
}
