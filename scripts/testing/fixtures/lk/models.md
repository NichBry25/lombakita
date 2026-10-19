# Synthetic model table

Fixture for the lk script tests. The ids are made up and name no real model.

## Classes

| Class | Model |
|---|---|
| Heavy | claude-test-heavy |
| Standard | claude-test-standard |
| Light | claude-test-light |

## Jobs

| Job | Tier | Class |
|---|---|---|
| controller | any | Heavy |
| implement | 1 | Standard |
| implement | 3 | Light |
| implement | any | Standard |
| review | 1 | Heavy |
| lookup | any | Light |
