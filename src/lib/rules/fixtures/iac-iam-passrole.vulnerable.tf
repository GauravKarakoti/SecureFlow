data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "AllowPassRoleOnAll"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["*"]
  }
}
