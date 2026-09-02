export class ThreeIKError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThreeIKError';
    this.code = code;
  }

  static boneNotFound(name: string): ThreeIKError {
    return new ThreeIKError('BONE_NOT_FOUND', `Bone not found in skeleton: "${name}"`);
  }

  static invalidChain(reason: string): ThreeIKError {
    return new ThreeIKError('INVALID_CHAIN', `Invalid IK chain: ${reason}`);
  }

  static configError(reason: string): ThreeIKError {
    return new ThreeIKError('CONFIG_ERROR', reason);
  }
}
