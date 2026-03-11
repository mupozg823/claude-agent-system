def process_order(order):
    validate_order(order)
    total = calculate_order_total(order)
    send_order_notifications(order, total)
```

**Class Decomposition**
- Extract responsibilities to separate classes
- Create interfaces for dependencies
- Implement dependency injection
- Use composition over inheritance

**Pattern Application**
- Factory pattern for object creation
- Strategy pattern for algorithm variants
- Observer pattern for event handling
- Repository pattern for data access
- Decorator pattern for extending behavior

### 3. Refactored Implementation

Provide the complete refactored code with:

**Clean Code Principles**
- Meaningful names (searchable, pronounceable, no abbreviations)
- Functions do one thing well
- No side effects
- Consistent abstraction levels
- DRY (Don't Repeat Yourself)
- YAGNI (You Aren't Gonna Need It)

**Error Handling**
```python
# Use specific exceptions
class OrderValidationError(Exception):
    pass

class InsufficientInventoryError(Exception):
    pass

# Fail fast with clear messages
def validate_order(order):
    if not order.items:
        raise OrderValidationError("Order must contain at least one item")
    
    for item in order.items:
        if item.quantity <= 0:
            raise OrderValidationError(f"Invalid quantity for {item.name}")
```

**Documentation**
```python
def calculate_discount(order: Order, customer: Customer) -> Decimal:
    """
    Calculate the total discount for an order based on customer tier and order value.
    
    Args:
        order: The order to calculate discount for
        customer: The customer making the order
        
    Returns:
        The discount amount as a Decimal
        
    Raises:
        ValueError: If order total is negative
    """
```

### 4. Testing Strategy

Generate comprehensive tests for the refactored code:

**Unit Tests**
```python
class TestOrderProcessor:
    def test_validate_order_empty_items(self):
        order = Order(items=[])
        with pytest.raises(OrderValidationError):
            validate_order(order)
    
    def test_calculate_discount_vip_customer(self):
        order = create_test_order(total=1000)
        customer = Customer(tier="VIP")
        discount = calculate_discount(order, customer)
        assert discount == Decimal("100.00")  # 10% VIP discount
```

**Test Coverage**
- All public methods tested
- Edge cases covered
- Error conditions verified
- Performance benchmarks included

### 5. Before/After Comparison

Provide clear comparisons showing improvements:

**Metrics**
- Cyclomatic complexity reduction
- Lines of code per method
- Test coverage increase
- Performance improvements

**Example**
```
Before:
- processData(): 150 lines, complexity: 25
- 0% test coverage
- 3 responsibilities mixed

After:
- validateInput(): 20 lines, complexity: 4
- transformData(): 25 lines, complexity: 5  
- saveResults(): 15 lines, complexity: 3
- 95% test coverage
- Clear separation of concerns
```

### 6. Migration Guide

If breaking changes are introduced:

**Step-by-Step Migration**
1. Install new dependencies
2. Update import statements
3. Replace deprecated methods
4. Run migration scripts
5. Execute test suite

**Backward Compatibility**
```python
# Temporary adapter for smooth migration
class LegacyOrderProcessor:
    def __init__(self):
        self.processor = OrderProcessor()
    
    def process(self, order_data):
        # Convert legacy format
        order = Order.from_legacy(order_data)
        return self.processor.process(order)
```

### 7. Performance Optimizations

Include specific optimizations:

**Algorithm Improvements**
```python
# Before: O(n²)
for item in items:
    for other in items:
        if item.id == other.id:
            # process

# After: O(n)
item_map = {item.id: item for item in items}
for item_id, item in item_map.items():
    # process
```

**Caching Strategy**
```python
from functools import lru_cache

@lru_cache(maxsize=128)
def calculate_expensive_metric(data_id: str) -> float:
    # Expensive calculation cached
    return result
```

### 8. Code Quality Checklist

Ensure the refactored code meets these criteria:

- [ ] All methods < 20 lines
- [ ] All classes < 200 lines
- [ ] No method has > 3 parameters
- [ ] Cyclomatic complexity < 10
- [ ] No nested loops > 2 levels
- [ ] All names are descriptive
- [ ] No commented-out code
- [ ] Consistent formatting
- [ ] Type hints added (Python/TypeScript)
- [ ] Error handling comprehensive
- [ ] Logging added for debugging
- [ ] Performance metrics included
- [ ] Documentation complete
- [ ] Tests achieve > 80% coverage
- [ ] No security vulnerabilities


## Detailed Reference

For complete instructions, see [reference.md](reference.md).

## Severity Levels

Rate issues found and improvements made:

**Critical**: Security vulnerabilities, data corruption risks, memory leaks
**High**: Performance bottlenecks, maintainability blockers, missing tests
**Medium**: Code smells, minor performance issues, incomplete documentation  
**Low**: Style inconsistencies, minor naming issues, nice-to-have features

## Output Format

1. **Analysis Summary**: Key issues found and their impact
2. **Refactoring Plan**: Prioritized list of changes with effort estimates
3. **Refactored Code**: Complete implementation with inline comments explaining changes
4. **Test Suite**: Comprehensive tests for all refactored components
5. **Migration Guide**: Step-by-step instructions for adopting changes
6. **Metrics Report**: Before/after comparison of code quality metrics

Focus on delivering practical, incremental improvements that can be adopted immediately while maintaining system stability.

