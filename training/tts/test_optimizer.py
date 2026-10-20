import unittest
try:
    import torch
except ImportError:
    torch = None


@unittest.skipIf(torch is None, 'GPU image includes PyTorch; lightweight local environment does not')
class OptimizerTests(unittest.TestCase):
    def test_restore_forces_conservative_optimizer_and_preserves_moments(self):
        from safe_optimizer import SafeAdamW
        param = torch.nn.Parameter(torch.tensor([1.0, 2.0]))
        optimizer = SafeAdamW([param], lr=2e-5)
        param.grad = torch.tensor([0.3, 0.4])
        optimizer.step()
        state = optimizer.state_dict()
        state['param_groups'][0]['foreach'] = None  # actual legacy CUDA checkpoint flag
        resumed = SafeAdamW([param], lr=2e-5)
        resumed.load_state_dict(state)
        self.assertIs(resumed.param_groups[0]['foreach'], False)
        self.assertIs(resumed.param_groups[0]['fused'], False)
        self.assertEqual(resumed.state[param]['step'].item(), 1)
        self.assertTrue(torch.equal(resumed.state[param]['exp_avg'], optimizer.state[param]['exp_avg']))
        param.grad = torch.tensor([float('nan'), 0.0])
        with self.assertRaises(FloatingPointError):
            resumed.step()
