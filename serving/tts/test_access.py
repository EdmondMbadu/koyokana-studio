import unittest
from unittest.mock import Mock, patch

from access import AccessError, StudioAccess


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.access = StudioAccess.__new__(StudioAccess)
        self.access.db = Mock()
        self.access.user_limit = 200
        self.access.global_limit = 500

    def test_rejects_missing_and_expired_tokens_before_reading_profiles(self):
        with self.assertRaises(AccessError):
            self.access.authorize('')
        with patch('access.auth.verify_id_token', side_effect=ValueError('expired')):
            with self.assertRaises(AccessError):
                self.access.authorize('Bearer invalid-token')
        self.access.db.collection.assert_not_called()

    def test_admin_is_checked_from_current_profile_on_every_request(self):
        profile = self.access.db.collection.return_value.document.return_value.get.return_value
        profile.exists = True
        with patch('access.auth.verify_id_token', return_value={'uid': 'admin-uid'}):
            profile.to_dict.return_value = {'role': 'admin'}
            self.assertEqual(self.access.authorize('Bearer signed-token'), 'admin-uid')
            profile.to_dict.return_value = {'role': 'reviewer'}
            with self.assertRaises(AccessError) as caught:
                self.access.authorize('Bearer signed-token')
            self.assertEqual(caught.exception.status, 403)

    def quota(self, total, user):
        global_ref = self.access.db.collection.return_value.document.return_value
        global_ref.get.return_value.to_dict.return_value = total
        user_ref = global_ref.collection.return_value.document.return_value
        user_ref.get.return_value.to_dict.return_value = user
        with patch('access.firestore.transactional', side_effect=lambda f: f), patch('access.time.time', return_value=1792475000):
            self.access.reserve('uid')

    def test_reserves_global_and_user_counts_in_one_transaction(self):
        self.quota({'count': 2}, {'count': 1, 'lastAt': 1792474900})
        writes = self.access.db.transaction.return_value.set.call_args_list
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0].args[1]['count'], 3)
        self.assertEqual(writes[1].args[1]['count'], 2)

    def test_daily_and_spacing_limits_fail_before_writes(self):
        for total, user in [({'count': 500}, {}), ({}, {'count': 200}), ({}, {'lastAt': 1792474999})]:
            with self.subTest(total=total, user=user), self.assertRaises(AccessError) as caught:
                self.quota(total, user)
            self.assertEqual(caught.exception.status, 429)
        self.access.db.transaction.return_value.set.assert_not_called()
