/** Transactional sandbox copy. Real sender identity/provider remain release gates. */
export function renderMarketingMail(
  event: string,
  links: { confirm?: string; preferences?: string; unsubscribe?: string },
) {
  if (event === 'confirmation')
    return {
      subject: 'Confirm your 1Pass launch updates',
      text: `You requested occasional product progress and launch news for your selected topics. Confirm only if you made this request:\n\n${links.confirm}\n\nThe confirmation link expires after the configured confirmation period and works once. Until you confirm, you are not subscribed. If this was not you, ignore this message. After confirmation, a management email provides preferences and unsubscribe links. This is a marketing subscription, not a password-vault account. No reward or priority access is promised.\n\nLocal sandbox message: no email was delivered externally.`,
    };
  if (event === 'management')
    return {
      subject: 'Manage your 1Pass launch updates',
      text: `Your launch-update preferences are yours to control. Expect occasional product progress and launch news for your selected topics.\n\nPreferences (time-limited): ${links.preferences}\nUnsubscribe: ${links.unsubscribe}\n\nIf your preferences link expires, request a fresh link from the website. Unsubscribing does not require a product account or password. Never send us passwords, recovery material or other secrets.\n\nLocal sandbox message: no email was delivered externally.`,
    };
  return {
    subject: 'Local marketing enquiry received',
    text: 'An enquiry reference is available to authorized operators. No private message is included in this notification.',
  };
}
