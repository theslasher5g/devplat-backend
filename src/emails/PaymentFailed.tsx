import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function PaymentFailed({ teamName, amount, attemptsRemain, billingUrl }: {
  teamName: string; amount: string; attemptsRemain: boolean; billingUrl: string;
}) {
  return (
    <Layout preview={`We couldn't process your payment for ${teamName}`}>
      <Eyebrow>Billing</Eyebrow>
      <Heading>We couldn&rsquo;t process your payment.</Heading>
      <Paragraph>
        The last charge for <strong>{teamName}</strong>{amount ? <> ({amount})</> : null} didn&rsquo;t go through.
        This is usually an expired card, a spending limit, or a bank asking for confirmation.
      </Paragraph>
      <Paragraph>
        {attemptsRemain
          ? 'We\'ll try again over the next few days. Updating your payment method now avoids any interruption to your test runs.'
          : 'This was the last automatic attempt. Without a working payment method your plan drops to Free, and running environments stop being available.'}
      </Paragraph>
      <CtaButton href={billingUrl}>Update payment method</CtaButton>
      <FallbackLink href={billingUrl} />
    </Layout>
  );
}
