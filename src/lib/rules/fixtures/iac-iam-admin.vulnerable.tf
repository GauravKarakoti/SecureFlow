data "aws_iam_policy_document" "admin_escalation" {
  statement {
    sid       = "FullAdminAccess"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }
}
