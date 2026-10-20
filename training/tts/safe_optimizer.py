"""Keep the same AdamW mathematics with conservative CUDA execution."""
import torch


class SafeAdamW(torch.optim.AdamW):
    def __init__(self, *args, **kwargs):
        kwargs.update(foreach=False, fused=False)
        super().__init__(*args, **kwargs)

    def load_state_dict(self, state_dict):
        result = super().load_state_dict(state_dict)
        # Checkpoints retain param-group flags. Do not let an old foreach=None
        # silently re-enable the CUDA tensor-list implementation after restore.
        for group in self.param_groups:
            group.update(foreach=False, fused=False)
        return result

    def step(self, closure=None):
        checks = [torch.isfinite(p.grad).all() for group in self.param_groups
                  for p in group['params'] if p.grad is not None]
        if checks and not torch.stack(checks).all().item():
            raise FloatingPointError('Nonfinite gradients; refusing optimizer update')
        return super().step(closure)
