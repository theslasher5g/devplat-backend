import { Body, Container, Font, Head, Hr, Html, Link, Preview, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';

/** devplat design tokens — mirror src/index.css in devplat-frontend. */
export const colors = {
  paper: '#F4F4F1',
  ink: '#0C0C0C',
  inkSoft: '#4A4A46',
  line: '#DEDED8',
  red: '#E63312',
};

export const fontStack = "'Space Grotesk', system-ui, -apple-system, sans-serif";
export const monoStack = "'JetBrains Mono', 'Courier New', monospace";
export const dotoStack = "'Doto', 'JetBrains Mono', monospace";

export function Layout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head>
        <Font fontFamily="Space Grotesk" fallbackFontFamily="Helvetica"
          webFont={{ url: 'https://fonts.gstatic.com/s/spacegrotesk/v16/V8mQoQDjQSkFtoMM3T6r8E7mF71Q-gOoraIAEj7oUUsjNsFjTDJK.woff2', format: 'woff2' }}
          fontWeight={400} fontStyle="normal" />
        <Font fontFamily="Doto" fallbackFontFamily="monospace"
          webFont={{ url: 'https://fonts.gstatic.com/s/doto/v1/t5t2IRoeKYORG0WNMgnC3seB3TnPUk4e.woff2', format: 'woff2' }}
          fontWeight={800} fontStyle="normal" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: colors.paper, margin: 0, padding: '32px 12px', fontFamily: fontStack, color: colors.ink }}>
        <Container style={{ maxWidth: 520, margin: '0 auto' }}>
          <Section style={{ padding: '0 4px 16px' }}>
            <Text style={{ margin: 0, fontFamily: dotoStack, fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', color: colors.ink }}>
              devplat<span style={{ color: colors.red }}>●</span>
            </Text>
          </Section>
          <Section style={{ backgroundColor: '#FFFFFF', border: `1px solid ${colors.line}`, padding: '32px 32px 28px' }}>
            {children}
          </Section>
          <Section style={{ padding: '16px 4px 0' }}>
            <Text style={{ margin: 0, fontFamily: monoStack, fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase' as const, color: colors.inkSoft }}>
              devplat · CH-BSL-1 · Basel, Switzerland
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text style={{ margin: '0 0 12px', fontFamily: monoStack, fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase' as const, color: colors.inkSoft }}>
      <span style={{ color: colors.red, fontSize: 8, verticalAlign: 2 }}>●</span>&nbsp;&nbsp;{children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={{ margin: '0 0 12px', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.15 }}>{children}</Text>;
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.6, color: colors.inkSoft }}>{children}</Text>;
}

export function CtaButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: '8px 0 20px' }}>
      <Link href={href} style={{
        display: 'inline-block', backgroundColor: colors.ink, color: '#FFFFFF',
        fontSize: 14, fontWeight: 500, padding: '12px 28px', textDecoration: 'none',
      }}>
        {children}
      </Link>
    </Section>
  );
}

export function FallbackLink({ href }: { href: string }) {
  return (
    <>
      <Hr style={{ borderColor: colors.line, margin: '4px 0 16px' }} />
      <Text style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: colors.inkSoft }}>
        If the button doesn't work, copy this link into your browser:
        <br />
        <Link href={href} style={{ color: colors.red, fontFamily: monoStack, fontSize: 11, wordBreak: 'break-all' as const }}>{href}</Link>
      </Text>
    </>
  );
}
