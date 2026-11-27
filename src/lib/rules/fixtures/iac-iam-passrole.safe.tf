data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "ScopedPassRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::123456789012:role/ecs-task-execution-role"]
  }

  statement {
    sid       = "OtherActionWildcardResource"
    effect    = "Allow"
    actions   = ["iam:GetRole", "iam:ListRoles"]
    resources = ["*"]
  }
}
