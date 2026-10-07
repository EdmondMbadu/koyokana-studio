import { passwordProblem } from './password';

describe('passwordProblem', () => {
  it('requires at least eight characters and matching confirmation', () => {
    expect(passwordProblem('short', 'short')).toContain('8 characters');
    expect(passwordProblem('long-password', 'other-password')).toContain('do not match');
    expect(passwordProblem('long-password', 'long-password')).toBeNull();
  });
});
